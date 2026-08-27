//! Lightweight 8-dimensional k-d tree for fast nearest-neighbor search.
//! Designed for WASM: no external deps, no threads, no allocator tricks.
//! Build is O(N log N), query is O(log N) average case.

use super::features::N_FEATURES;

/// A node in the k-d tree. Stores index into the original sample array.
#[derive(Debug, Clone)]
struct KdNode {
    /// Index into the original NormalizedSample array.
    idx: usize,
    /// Split dimension (0..N_FEATURES).
    split_dim: usize,
    /// Split value (feature value at split_dim).
    split_val: f64,
    /// Left child (points with feature[split_dim] < split_val).
    left: Option<Box<KdNode>>,
    /// Right child.
    right: Option<Box<KdNode>>,
}

/// Pre-built k-d tree index over normalized feature vectors.
/// Enables O(log N) nearest-neighbor queries instead of O(N) brute force.
#[derive(Debug, Clone)]
pub struct KdTree {
    root: Option<Box<KdNode>>,
    /// Flat array of (features, speed_ms) for indexed access.
    data: Vec<([f64; N_FEATURES], f64)>,
}

impl KdTree {
    /// Build a k-d tree from normalized samples.
    /// O(N log N) construction time.
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

        // Partition around the median of the split dimension. O(N) average
        // via quickselect instead of a full O(N log N) sort per level; the
        // resulting tree is equivalent (subtree membership is all that
        // matters, not intra-subtree order).
        let mid = indices.len() / 2;
        indices.select_nth_unstable_by(mid, |&a, &b| {
            data[a].0[dim]
                .partial_cmp(&data[b].0[dim])
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let median_idx = indices[mid];

        let (left_indices, right_part) = indices.split_at_mut(mid);
        // right_part[0] is the median; right_part[1..] is the right subtree
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

    /// Find the k nearest neighbors to query point.
    /// Returns Vec<(distance_sq, speed_ms)> sorted by distance.
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

        // Compute distance to this node
        let d = dist_sq_inline(query, point);
        best.push(d, speed);

        // Determine which subtree to search first (the side query falls on)
        let diff = query[node.split_dim] - node.split_val;
        let (first, second) = if diff < 0.0 {
            (&node.left, &node.right)
        } else {
            (&node.right, &node.left)
        };

        // Always search the closer subtree
        if let Some(ref child) = first {
            self.search(child, query, best);
        }

        // Only search the farther subtree if the splitting plane is closer
        // than the current worst neighbor (pruning)
        let plane_dist_sq = diff * diff;
        if plane_dist_sq < best.worst_dist() {
            if let Some(ref child) = second {
                self.search(child, query, best);
            }
        }
    }
}

/// Max-heap of size K for tracking nearest neighbors.
/// Maintains the K smallest distances seen so far.
struct BoundedHeap {
    capacity: usize,
    /// Sorted by distance ascending. Last element = worst (farthest).
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
            // Insertion sort to maintain order
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

/// Inline distance squared for 8D feature vectors.
#[inline(always)]
fn dist_sq_inline(a: &[f64; N_FEATURES], b: &[f64; N_FEATURES]) -> f64 {
    let mut sum = 0.0;
    // Unrolled for 8 dimensions — compiler will vectorize
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
        // Closest should be [0,0,...] or [0.1,0.1,...] — both near query
        assert!(result[0].1 == 5.0 || result[0].1 == 6.0);
    }
}
