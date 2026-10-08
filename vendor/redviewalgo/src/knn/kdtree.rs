//! Arbre k-d léger à 8 dimensions pour une recherche rapide des plus proches voisins.
//! Conçu pour le WASM : sans dépendance externe, sans threads, sans astuce d'allocateur.
//! Construction en O(N log N), requête en O(log N) en moyenne.

use super::features::N_FEATURES;

/// Un nœud de l'arbre k-d. Stocke un indice dans le tableau d'échantillons d'origine.
#[derive(Debug, Clone)]
struct KdNode {
    /// Indice dans le tableau NormalizedSample d'origine.
    idx: usize,
    /// Dimension de coupe (0..N_FEATURES).
    split_dim: usize,
    /// Valeur de coupe (valeur de la caractéristique à split_dim).
    split_val: f64,
    /// Enfant gauche (points avec feature[split_dim] < split_val).
    left: Option<Box<KdNode>>,
    /// Enfant droit.
    right: Option<Box<KdNode>>,
}

/// Index en arbre k-d préconstruit sur les vecteurs de caractéristiques normalisés.
/// Permet des requêtes de plus proches voisins en O(log N) au lieu d'une force brute en O(N).
#[derive(Debug, Clone)]
pub struct KdTree {
    root: Option<Box<KdNode>>,
    /// Tableau à plat de (caractéristiques, speed_ms) pour un accès indexé.
    data: Vec<([f64; N_FEATURES], f64)>,
}

impl KdTree {
    /// Construit un arbre k-d à partir d'échantillons normalisés.
    /// Construction en O(N log N).
    pub fn build(features: &[[f64; N_FEATURES]], speeds: &[f64]) -> Self {
        let n = features.len();
        assert_eq!(n, speeds.len());

        let data: Vec<([f64; N_FEATURES], f64)> = features
            .iter()
            .zip(speeds.iter())
            .map(|(f, &s)| (*f, s))
            .collect();

        let mut indices: Vec<usize> = (0..n).collect();
        let root = Self::build_recursive(&data, &mut indices, 0);

        KdTree { root, data }
    }

    fn build_recursive(
        data: &[([f64; N_FEATURES], f64)],
        indices: &mut [usize],
        depth: usize,
    ) -> Option<Box<KdNode>> {
        if indices.is_empty() {
            return None;
        }

        let dim = depth % N_FEATURES;

        // Partitionne autour de la médiane de la dimension de coupe. O(N) en
        // moyenne par quickselect au lieu d'un tri complet en O(N log N) à chaque
        // niveau ; l'arbre obtenu est équivalent (seule l'appartenance aux
        // sous-arbres compte, pas l'ordre à l'intérieur d'un sous-arbre).
        let mid = indices.len() / 2;
        indices.select_nth_unstable_by(mid, |&a, &b| {
            data[a].0[dim]
                .partial_cmp(&data[b].0[dim])
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let median_idx = indices[mid];

        let (left_indices, right_part) = indices.split_at_mut(mid);
        // right_part[0] est la médiane ; right_part[1..] est le sous-arbre droit
        let right_indices = if right_part.len() > 1 {
            &mut right_part[1..]
        } else {
            &mut []
        };

        Some(Box::new(KdNode {
            idx: median_idx,
            split_dim: dim,
            split_val: data[median_idx].0[dim],
            left: Self::build_recursive(data, left_indices, depth + 1),
            right: Self::build_recursive(data, right_indices, depth + 1),
        }))
    }

    /// Trouve les k plus proches voisins du point de requête.
    /// Renvoie Vec<(distance_sq, speed_ms)> trié par distance.
    pub fn knn_query(&self, query: &[f64; N_FEATURES], k: usize) -> Vec<(f64, f64)> {
        let mut best = BoundedHeap::new(k);
        if let Some(ref root) = self.root {
            self.search(root, query, &mut best);
        }
        best.into_sorted()
    }

    fn search(&self, node: &KdNode, query: &[f64; N_FEATURES], best: &mut BoundedHeap) {
        let point = &self.data[node.idx].0;
        let speed = self.data[node.idx].1;

        // Distance à ce nœud
        let d = dist_sq_inline(query, point);
        best.push(d, speed);

        // Détermine le sous-arbre à explorer d'abord (le côté où tombe la requête)
        let diff = query[node.split_dim] - node.split_val;
        let (first, second) = if diff < 0.0 {
            (&node.left, &node.right)
        } else {
            (&node.right, &node.left)
        };

        // Explore toujours le sous-arbre le plus proche
        if let Some(ref child) = first {
            self.search(child, query, best);
        }

        // N'explore le sous-arbre le plus éloigné que si le plan de coupe est plus
        // proche que le pire voisin actuel (élagage)
        let plane_dist_sq = diff * diff;
        if plane_dist_sq < best.worst_dist() {
            if let Some(ref child) = second {
                self.search(child, query, best);
            }
        }
    }
}

/// Tas max de taille K pour suivre les plus proches voisins.
/// Garde les K plus petites distances vues jusqu'ici.
struct BoundedHeap {
    capacity: usize,
    /// Trié par distance croissante. Dernier élément = le pire (le plus éloigné).
    items: Vec<(f64, f64)>,
}

impl BoundedHeap {
    fn new(capacity: usize) -> Self {
        BoundedHeap {
            capacity,
            items: Vec::with_capacity(capacity + 1),
        }
    }

    #[inline]
    fn worst_dist(&self) -> f64 {
        if self.items.len() < self.capacity {
            f64::MAX
        } else {
            self.items[self.items.len() - 1].0
        }
    }

    #[inline]
    fn push(&mut self, dist: f64, speed: f64) {
        if self.items.len() < self.capacity {
            self.items.push((dist, speed));
            if self.items.len() == self.capacity {
                self.items.sort_unstable_by(|a, b| {
                    a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        } else if dist < self.items[self.capacity - 1].0 {
            self.items[self.capacity - 1] = (dist, speed);
            // Tri par insertion pour garder l'ordre
            let mut i = self.capacity - 1;
            while i > 0 && self.items[i].0 < self.items[i - 1].0 {
                self.items.swap(i, i - 1);
                i -= 1;
            }
        }
    }

    fn into_sorted(self) -> Vec<(f64, f64)> {
        let mut v = self.items;
        v.sort_unstable_by(|a, b| {
            a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        v
    }
}

/// Distance au carré en ligne pour les vecteurs de caractéristiques 8D.
#[inline(always)]
fn dist_sq_inline(a: &[f64; N_FEATURES], b: &[f64; N_FEATURES]) -> f64 {
    let mut sum = 0.0;
    // Déroulé pour 8 dimensions — le compilateur vectorisera
    sum += (a[0] - b[0]) * (a[0] - b[0]);
    sum += (a[1] - b[1]) * (a[1] - b[1]);
    sum += (a[2] - b[2]) * (a[2] - b[2]);
    sum += (a[3] - b[3]) * (a[3] - b[3]);
    sum += (a[4] - b[4]) * (a[4] - b[4]);
    sum += (a[5] - b[5]) * (a[5] - b[5]);
    sum += (a[6] - b[6]) * (a[6] - b[6]);
    sum += (a[7] - b[7]) * (a[7] - b[7]);
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kdtree_basic() {
        let features = vec![
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
            [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
        ];
        let speeds = vec![5.0, 10.0, 6.0];
        let tree = KdTree::build(&features, &speeds);
        let query = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
        let result = tree.knn_query(&query, 2);
        assert_eq!(result.len(), 2);
        // Le plus proche doit être [0,0,...] ou [0.1,0.1,...] — tous deux près de la requête
        assert!(result[0].1 == 5.0 || result[0].1 == 6.0);
    }
}
