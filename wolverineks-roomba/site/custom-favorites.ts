type FavoriteRegion = {
  region_id: string;
  region_name: string;
  region_type: string;
  type: string;
};

export type CustomFavoriteSpace = {
  id: string;
  name: string;
  pmap_id: string | null;
  user_pmapv_id: string | null;
  space_kind?: "room" | "zone";
  clean_estimate_seconds?: number | null;
  command_regions?: FavoriteRegion[];
};

export type CustomFavorite = {
  id: string;
  name: string;
  pmap_id: string | null;
  user_pmapv_id: string | null;
  ordered: boolean;
  region_count: number;
  regions_summary: string;
  runnable: boolean;
  source: "local";
  clean_estimate_seconds: number | null;
  clean_estimate_label: string | null;
  command_regions: FavoriteRegion[];
};

type CustomFavoriteDef = {
  id: string;
  name: string;
  roomNames: string[];
  ordered: boolean;
};

const CUSTOM_FAVORITE_DEFS: CustomFavoriteDef[] = [
  {
    id: "custom:after-dinner",
    name: "After Dinner",
    roomNames: ["Kitchen", "Dining Room"],
    ordered: true,
  },
];

function formatCleanEstimateLabel(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return "<1 min";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`;
}

function normalizeRoomName(name: string): string {
  return name.trim().toLowerCase();
}

function findSpaceByName(spaces: CustomFavoriteSpace[], roomName: string): CustomFavoriteSpace | undefined {
  const target = normalizeRoomName(roomName);
  return spaces.find(
    (space) =>
      space.space_kind === "room" && normalizeRoomName(space.name) === target && space.command_regions?.length,
  );
}

function buildCustomFavorite(def: CustomFavoriteDef, spaces: CustomFavoriteSpace[]): CustomFavorite | null {
  const matchedRooms: CustomFavoriteSpace[] = [];
  for (const roomName of def.roomNames) {
    const room = findSpaceByName(spaces, roomName);
    if (!room) return null;
    matchedRooms.push(room);
  }

  const commandRegions: FavoriteRegion[] = matchedRooms.flatMap((room) => room.command_regions ?? []);
  if (!commandRegions.length) return null;

  const pmapId = matchedRooms[0]?.pmap_id ?? null;
  const userPmapvId = matchedRooms[0]?.user_pmapv_id ?? null;
  const estimateSeconds = matchedRooms.reduce(
    (total, room) => total + (room.clean_estimate_seconds ?? 0),
    0,
  );

  return {
    id: def.id,
    name: def.name,
    pmap_id: pmapId,
    user_pmapv_id: userPmapvId,
    ordered: def.ordered,
    region_count: commandRegions.length,
    regions_summary: commandRegions.map((region) => region.region_name || region.region_id).join(", "),
    runnable: Boolean(pmapId && userPmapvId),
    source: "local",
    clean_estimate_seconds: estimateSeconds || null,
    clean_estimate_label: estimateSeconds ? formatCleanEstimateLabel(estimateSeconds) : null,
    command_regions: commandRegions,
  };
}

export function resolveCustomFavorites(spaces: CustomFavoriteSpace[]): CustomFavorite[] {
  if (!spaces.length) return [];
  return CUSTOM_FAVORITE_DEFS.map((def) => buildCustomFavorite(def, spaces)).filter(
    (favorite): favorite is CustomFavorite => favorite !== null && favorite.runnable,
  );
}

export function getCustomFavoriteById(
  favoriteId: string,
  spaces: CustomFavoriteSpace[],
): CustomFavorite | undefined {
  const def = CUSTOM_FAVORITE_DEFS.find((entry) => entry.id === favoriteId);
  if (!def) return undefined;
  const favorite = buildCustomFavorite(def, spaces);
  return favorite?.runnable ? favorite : undefined;
}

export function appendCustomFavorites<T extends { id: string }>(
  favorites: T[],
  spaces: CustomFavoriteSpace[],
): Array<T | CustomFavorite> {
  const saved = favorites.filter((favorite) => !favorite.id.startsWith("custom:"));
  const custom = resolveCustomFavorites(spaces);
  if (!custom.length) return saved;

  const merged: Array<T | CustomFavorite> = [...saved];
  const seen = new Set(saved.map((favorite) => favorite.id));
  for (const favorite of custom) {
    if (seen.has(favorite.id)) continue;
    merged.push(favorite);
    seen.add(favorite.id);
  }
  return merged;
}