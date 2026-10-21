// Bake settings for the modelled-needle conifers (scripts/conifer.mjs).
//   mode: 'flat' = one card per spray (fir: flat two-ranked sprays), 'cross' = crossed pair along the twig (pine tufts)
//   cell0/cell1: k-means seed spacing (m) for LOD0 / LOD1 clusters, max0/max1: card cap for the largest variant
//   density0/1: sprite texel density (px/m), shrunk until the sprites fit the atlas
//   trunk*/branch*: wood triangle budgets, twiglet1: LOD1 drops branch pieces shorter than this (m)
//   sigma: needle extinction per voxel for the crown light, aoMin: darkest crown occlusion
export const CONIFERS = {
  fir_tree_01: {
    mode: 'flat', skip: ['fir_tree_01_c_LOD0'], cell0: 0.42, cell1: 0.85, max0: 3200, max1: 760, sprites0: 16, sprites1: 6, density0: 900, density1: 300, atlas: [2048, 1024],
    trunk0: 600, trunk1: 200, branch0: 1400, branch1: 450, twiglet0: 0.3, twiglet1: 1.2, sigma: 0.012, cardScale0: 1.2, grade: { sat: 1.08, mul: [0.55, 0.68, 0.6] },
    closeup: { x0: -3.0, x1: -0.6, y0: 6.0, y1: 8.4 },
  },
  pine_tree_01: {
    mode: 'cross', cell0: 0.45, cell1: 1.2, max0: 1400, max1: 290, sprites0: 12, sprites1: 6, density0: 640, density1: 240, atlas: [2048, 1024],
    trunk0: 600, trunk1: 160, branch0: 1700, branch1: 380, twiglet0: 0.3, twiglet1: 1.5, sigma: 0.012, cardScale0: 1.12, cardScale1: 1.1, grade: { sat: 1.15, mul: [1.2, 1.6, 1.4] },
    closeup: { x0: -3.5, x1: -0.5, y0: 9.0, y1: 12.0 },
  },
  // young firs with foliage down to the ground: the conifers a child can walk right up to
  fir_sapling_medium: {
    mode: 'flat', atlasFrom: 'fir_tree_01', cell0: 0.3, cell1: 0.75, max0: 2600, max1: 600,
    trunk0: 0, trunk1: 0, branch0: 1200, branch1: 300, twiglet0: 0.25, twiglet1: 0.8, sigma: 0.012, cardScale0: 1.45, cardScale1: 1.2, grade: { sat: 1.08, mul: [0.55, 0.68, 0.6] },
    closeup: { x0: -2.0, x1: 0.5, y0: 1.0, y1: 3.5 },
  },
  pine_sapling_medium: {
    mode: 'cross', atlasFrom: 'pine_tree_01', cell0: 0.38, cell1: 0.95, max0: 1300, max1: 300,
    trunk0: 500, trunk1: 160, branch0: 1500, branch1: 400, twiglet0: 0.25, twiglet1: 1.0, sigma: 0.012, cardScale0: 1.12, cardScale1: 1.1, grade: { sat: 1.15, mul: [1.2, 1.6, 1.4] },
    closeup: { x0: -2.5, x1: 0.5, y0: 2.0, y1: 5.0 },
  },
};
