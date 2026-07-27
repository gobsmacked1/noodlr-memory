// The purpose-specific collections. Splitting by purpose lets an advanced user
// reset one focused area of campaign memory (e.g. just "scenes") without wiping
// everything and re-ingesting the whole world.
export const COLLECTIONS = Object.freeze({
  system_rules:	"current game system rules",
  player_locations:	"scene location and status of which at least one player has knowledge",
  gm_locations:	"scene location and status of which no player has knowledge, e.g., traps, secret doors, etc",
  player_npc_state:	"NPC location and status of which at least one player has knowledge",
  gm_npc_state:	"NPC location and status of which no player has knowledge, e.g., merchants, slain/living quest-givers, etc",
  player_calendar:	"calendar events of which at least one player has knowledge",
  gm_calendar:	"calendar events of which no player has knowledge, e.g., holidays, cult ritual ceremonies, etc",
  player_chat:	"text and audio transcription which contain at least one player",
  gm_chat:	"text and audio transcription which include no player, e.g., encounter planning, plot twists, villain motivations, etc",
  player_history:	"events that unfolded of which at least one player has knowledge",
  gm_history:	"events that unfolded of which no player has knowledge, e.g., abducted princesses, murdered hobos, etc",
  player_lore:	"world lore of which at least one player has knowledge",
  gm_lore:	"world lore of which no player has knowledge, e.g., haunted mansion, disease blighted orchard, etc",
  player_quests:	"quest progress of which at least one player has accepted",
  gm_quests:	"quest progress of which no player has accepted, e.g., 6 of 7 cellar rats slain, missing potion ingredient search, etc",
  player_macguffin:	"quest goal of which at least one player has knowledge",
  gm_macguffin:	"quest goal of which no player has knowledge, e.g., Excalibur, the Arkenstone, a horcrux, a lich's phylactery, etc",
  player_puzzle:	"challenge or mystery of which at least one player has knowledge",
  gm_puzzle:	"challenge or mystery of which no player has knowledge, e.g., townsfolk disappearances, floating lights in the forest, etc",
  player_goals:	"personal goals of which at least one player has knowledge",
  gm_goals:	"personal goals of which no player has knowledge, e.g., birthright claim to a lost throne, best swordsman in the realm, etc",
  player_story_arc:	"campaign story arc of which at least one player has knowledge",
  gm_story_arc:	"campaign story arc of which no player has knowledge, e.g., liberate the land from an evil arch made, stop a planar incursion, etc",
  player_factions:	"organizations of which at least one player has knowledge",
  gm_factions:	"organizations of which no player has knowledge, e.g., The Harpers, The Zhentarim, The Cobalt Soul, etc",
  player_reputations:	"attitudes towards the player of which at least one player has knowledge",
  gm_reputations:	"attitudes towards the player of which no player has knowledge, e.g., aasimars killed on sight by demons, wood-elves more trusted by beasts, etc",
  player_effects:	"boons and banes of which at least one player has knowledge",
  gm_effects:	"boons and banes of which no player has knowledge, e.g., blessed by Mystra, infected by Lycanthropy, etc",
  player_sheets:	"skills and abilities of which at least one player has knowledge",
  gm_sheets:	"skills and abilities of which no player has knowledge, e.g., exhibited innate sorcery for first time, made an unknowing pact with a demon, etc",
  player_inventory:	"items of which at least one player has knowledge",
  gm_inventory:	"items of which no player has knowledge, e.g., learned a new weapon mastery, attuned to a cursed item, etc",
  docs:	"misc imported documents, e.g., TXT, PDF, CSV, JSON, and YAML",
});

export const COLLECTION_IDS = Object.freeze(Object.keys(COLLECTIONS));

export function isValidCollection(id) {
  return Object.prototype.hasOwnProperty.call(COLLECTIONS, id);
}
