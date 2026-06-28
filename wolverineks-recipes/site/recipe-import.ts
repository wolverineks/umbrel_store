const MAX_TEXT_LENGTH = 12000;
const FETCH_TIMEOUT_MS = 20000;

export const RECIPE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Recipe title" },
    description: { type: ["string", "null"], description: "Short description or null" },
    servings: { type: ["string", "null"], description: "Servings/yield as written, or null" },
    prep_time: { type: ["string", "null"], description: "Prep time as written, or null" },
    cook_time: { type: ["string", "null"], description: "Cook time as written, or null" },
    total_time: { type: ["string", "null"], description: "Total time as written, or null" },
    ingredients: {
      type: "array",
      items: { type: "string" },
      description: "Ingredient lines with quantities",
    },
    instructions: {
      type: "array",
      items: { type: "string" },
      description: "Step-by-step instructions",
    },
    notes: { type: ["string", "null"], description: "Tips or notes, or null" },
    source_url: { type: "string", description: "Original page URL" },
  },
  required: [
    "title",
    "description",
    "servings",
    "prep_time",
    "cook_time",
    "total_time",
    "ingredients",
    "instructions",
    "notes",
    "source_url",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You normalize messy recipe webpage content into a clean, printable recipe.

Rules:
- Preserve quantities, units, and ingredient names faithfully.
- Deduplicate repeated ingredients.
- Split combined instruction blobs into clear, actionable steps.
- Use null for missing optional fields instead of guessing.
- Keep the original source_url from the user message.
- If the page does not contain a recipe, return a best-effort extraction and note uncertainty in description.`;

export type ExtractedRecipePage = {
  title: string;
  url: string;
  text: string;
  extractionMethod: string;
  image_url: string | null;
};

function isRecipeType(type: unknown): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((value) => typeof value === "string" && value.toLowerCase().includes("recipe"));
}

function findRecipeInJsonLd(node: unknown): Record<string, unknown> | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (isRecipeType(record["@type"])) return record;
  if (record["@graph"]) return findRecipeInJsonLd(record["@graph"]);
  return null;
}

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      // ignore malformed JSON-LD
    }
    match = pattern.exec(html);
  }
  return blocks;
}

function metaContent(html: string, attr: string, value: string): string | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta[^>]+${attr}=["']${escaped}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${escaped}["']`,
    "i",
  );
  const match = pattern.exec(html);
  return (match?.[1] || match?.[2] || "").trim() || null;
}

function titleFromHtml(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return (match?.[1] || "").replace(/\s+/g, " ").trim().replace(/\s*[-|].*$/, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max = MAX_TEXT_LENGTH): string {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated]`;
}

function absolutizeUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function resolveImageUrl(value: unknown, baseUrl: string): string | null {
  if (!value) return null;
  if (typeof value === "string") return absolutizeUrl(value, baseUrl);
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = resolveImageUrl(item, baseUrl);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === "object" && value) {
    const record = value as Record<string, unknown>;
    return resolveImageUrl(record.url || record.contentUrl || record["@id"], baseUrl);
  }
  return null;
}

function serializeJsonLd(recipe: Record<string, unknown>): string {
  const fields = [
    "name",
    "description",
    "recipeYield",
    "prepTime",
    "cookTime",
    "totalTime",
    "recipeIngredient",
    "recipeInstructions",
  ];
  const lines: string[] = [];
  for (const field of fields) {
    const value = recipe[field];
    if (!value) continue;
    if (Array.isArray(value)) {
      lines.push(`${field}:`);
      for (const item of value) {
        if (typeof item === "string") lines.push(`- ${item}`);
        else if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (typeof record.text === "string") lines.push(`- ${record.text}`);
          else if (typeof record.name === "string") lines.push(`- ${record.name}`);
        }
      }
    } else if (typeof value === "string") {
      lines.push(`${field}: ${value}`);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string") lines.push(`${field}: ${record.text}`);
    }
  }
  return lines.join("\n");
}

function extractImageUrl(html: string, jsonLd: Record<string, unknown> | null, pageUrl: string): string | null {
  if (jsonLd?.image) {
    const url = resolveImageUrl(jsonLd.image, pageUrl);
    if (url && !url.startsWith("data:")) return url;
  }
  const ogImage = metaContent(html, "property", "og:image");
  const fromOg = absolutizeUrl(ogImage, pageUrl);
  if (fromOg && !fromOg.startsWith("data:")) return fromOg;
  const twitterImage = metaContent(html, "name", "twitter:image");
  const fromTwitter = absolutizeUrl(twitterImage, pageUrl);
  if (fromTwitter && !fromTwitter.startsWith("data:")) return fromTwitter;
  return null;
}

function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid recipe page URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return parsed.href;
}

export async function fetchRecipePage(sourceUrl: string): Promise<ExtractedRecipePage> {
  const url = normalizeSourceUrl(sourceUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WolverineksRecipes/1.0; +https://github.com/wolverineks/umbrel_store)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not fetch the page.";
    throw new Error(`Could not fetch recipe page: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`Could not fetch recipe page (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error("URL did not return an HTML page.");
  }

  const html = await response.text();
  const pageUrl = response.url || url;
  const title = titleFromHtml(html) || pageUrl;
  let extractionMethod = "heuristic";
  let text = "";
  let jsonLd: Record<string, unknown> | null = null;

  for (const block of extractJsonLdBlocks(html)) {
    jsonLd = findRecipeInJsonLd(block);
    if (jsonLd) break;
  }

  if (jsonLd) {
    extractionMethod = "json-ld";
    text = serializeJsonLd(jsonLd);
  }

  if (!text) {
    extractionMethod = "heuristic";
    text = stripHtml(html);
  }

  text = truncate(text);
  if (!text || text.length < 40) {
    throw new Error("No recipe content found at that URL.");
  }

  return {
    title,
    url: pageUrl,
    text,
    extractionMethod,
    image_url: extractImageUrl(html, jsonLd, pageUrl),
  };
}

function buildUserPrompt(raw: ExtractedRecipePage): string {
  return `Source URL: ${raw.url}
Page title: ${raw.title}
Extraction method: ${raw.extractionMethod}

Recipe content:
${raw.text}`;
}

export async function formatRecipeWithGrok(
  raw: ExtractedRecipePage,
  apiKey: string,
  model: string,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(raw) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "recipe",
          schema: RECIPE_JSON_SCHEMA,
          strict: true,
        },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      throw new Error("Invalid xAI API key. Update it under Setup.");
    }
    if (response.status === 429) {
      throw new Error("Rate limited by xAI. Wait a moment and try again.");
    }
    throw new Error(`Grok API error (${response.status}): ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Grok returned an empty response.");
  }

  try {
    const recipe = JSON.parse(content) as Record<string, unknown>;
    if (!recipe.source_url) recipe.source_url = raw.url;
    return recipe;
  } catch {
    throw new Error("Failed to parse Grok response as JSON.");
  }
}