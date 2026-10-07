// ============================================
// Photo mode — on/off switch
// ============================================
//
// Frozen on 2026-10-07: the photo mode (sky, clouds, cinematic lighting of
// the LiDAR viewer) is switched off — no panel section, `?photo=1` ignored,
// no GPU resource created. The code stays in the tree, compiled and
// type-checked, so it can be picked up again: set this to true.
//
// State at the freeze: volumetric clouds rebuilt after Guerrilla's Nubis³
// (metaball voxel model `lib/cumulusModel.ts`, Nubis noise, altocumulus /
// cirrus sub-layers, per-sample sunset light). The last change — the baked
// lighting volume (512²×64 rgba8: sun depth, sky and ground visibility) and
// the clouds gathered closer to the tiles — was not validated: sunset views
// came out dark, cause not found yet.

export const PHOTO_MODE_ENABLED = false;
