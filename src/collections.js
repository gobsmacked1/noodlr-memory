// The purpose-specific collections. Splitting by purpose lets an advanced user
// reset one focused area of campaign memory (e.g. just "scenes") without wiping
// everything and re-ingesting the whole world.
export const COLLECTIONS = Object.freeze({
  chat: "Chat & transcriptions",
  lore: "World lore",
  rules: "Game system rules",
  sheets: "Character sheets & inventory",
  npc_state: "NPC state persistence",
  factions: "Factions & reputation",
  scenes: "Scene state",
  quests: "Quest tracking",
  docs: "Imported documents (TXT/PDF)",
});

export const COLLECTION_IDS = Object.freeze(Object.keys(COLLECTIONS));

export function isValidCollection(id) {
  return Object.prototype.hasOwnProperty.call(COLLECTIONS, id);
}
