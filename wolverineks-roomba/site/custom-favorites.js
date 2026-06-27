"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCustomFavorites = resolveCustomFavorites;
exports.getCustomFavoriteById = getCustomFavoriteById;
exports.appendCustomFavorites = appendCustomFavorites;
const CUSTOM_FAVORITE_DEFS = [
    {
        id: "custom:after-dinner",
        name: "After Dinner",
        roomNames: ["Kitchen", "Dining Room"],
        ordered: true,
    },
];
function formatCleanEstimateLabel(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    if (seconds < 60)
        return "<1 min";
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60)
        return `~${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`;
}
function normalizeRoomName(name) {
    return name.trim().toLowerCase();
}
function findSpaceByName(spaces, roomName) {
    const target = normalizeRoomName(roomName);
    return spaces.find((space) => space.space_kind === "room" && normalizeRoomName(space.name) === target && space.command_regions?.length);
}
function buildCustomFavorite(def, spaces) {
    const matchedRooms = [];
    for (const roomName of def.roomNames) {
        const room = findSpaceByName(spaces, roomName);
        if (!room)
            return null;
        matchedRooms.push(room);
    }
    const commandRegions = matchedRooms.flatMap((room) => room.command_regions ?? []);
    if (!commandRegions.length)
        return null;
    const pmapId = matchedRooms[0]?.pmap_id ?? null;
    const userPmapvId = matchedRooms[0]?.user_pmapv_id ?? null;
    const estimateSeconds = matchedRooms.reduce((total, room) => total + (room.clean_estimate_seconds ?? 0), 0);
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
function resolveCustomFavorites(spaces) {
    if (!spaces.length)
        return [];
    return CUSTOM_FAVORITE_DEFS.map((def) => buildCustomFavorite(def, spaces)).filter((favorite) => favorite !== null && favorite.runnable);
}
function getCustomFavoriteById(favoriteId, spaces) {
    const def = CUSTOM_FAVORITE_DEFS.find((entry) => entry.id === favoriteId);
    if (!def)
        return undefined;
    const favorite = buildCustomFavorite(def, spaces);
    return favorite?.runnable ? favorite : undefined;
}
function appendCustomFavorites(favorites, spaces) {
    const saved = favorites.filter((favorite) => !favorite.id.startsWith("custom:"));
    const custom = resolveCustomFavorites(spaces);
    if (!custom.length)
        return saved;
    const merged = [...saved];
    const seen = new Set(saved.map((favorite) => favorite.id));
    for (const favorite of custom) {
        if (seen.has(favorite.id))
            continue;
        merged.push(favorite);
        seen.add(favorite.id);
    }
    return merged;
}
