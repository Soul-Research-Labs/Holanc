//! # holanc-tree
//!
//! Incremental Poseidon Merkle tree (append-only, depth 20) that mirrors the
//! on-chain commitment tree. Used by the client to compute Merkle proofs for
//! transfer and withdraw circuits.

use holanc_primitives::commitment::hash_pair;
use thiserror::Error;

/// Default tree depth, matching SPL Account Compression configuration.
pub const TREE_DEPTH: usize = 20;

/// Maximum number of leaves: 2^TREE_DEPTH.
pub const MAX_LEAVES: u64 = 1 << TREE_DEPTH;

#[derive(Debug, Error)]
pub enum TreeError {
    #[error("Tree is full (max {0} leaves)")]
    TreeFull(u64),
    #[error("Leaf index {0} out of range")]
    IndexOutOfRange(u64),
    #[error("Hash computation failed")]
    HashFailed,
}

/// An incremental append-only Merkle tree using Poseidon hashing.
///
/// Stores only the "filled subtrees" (one node per level) and computes
/// roots incrementally, using O(depth) space instead of O(2^depth).
#[derive(Clone)]
pub struct MerkleTree {
    depth: usize,
    next_index: u64,
    /// One node per level: the last "filled" subtree hash at that level.
    filled_subtrees: Vec<[u8; 32]>,
    /// Pre-computed zero hashes for each level (empty subtree at level i).
    zeros: Vec<[u8; 32]>,
    /// Current root.
    root: [u8; 32],
    /// All leaves (for proof generation).
    leaves: Vec<[u8; 32]>,
}

impl MerkleTree {
    /// Create a new empty Merkle tree with the given depth.
    pub fn new(depth: usize) -> Self {
        let zeros = compute_zeros(depth);
        let filled_subtrees = zeros.clone();
        let root = zeros[depth];

        MerkleTree {
            depth,
            next_index: 0,
            filled_subtrees,
            zeros,
            root,
            leaves: Vec::new(),
        }
    }

    /// Create a tree with the default depth (20).
    pub fn default_depth() -> Self {
        Self::new(TREE_DEPTH)
    }

    /// Append a new leaf to the tree and return (leaf_index, new_root).
    pub fn append(&mut self, leaf: [u8; 32]) -> Result<(u64, [u8; 32]), TreeError> {
        let max = 1u64 << self.depth;
        if self.next_index >= max {
            return Err(TreeError::TreeFull(max));
        }

        let leaf_index = self.next_index;
        self.leaves.push(leaf);

        let mut current = leaf;
        let mut index = leaf_index;

        for level in 0..self.depth {
            if index % 2 == 0 {
                // Left child: pair with zero (right sibling doesn't exist yet)
                self.filled_subtrees[level] = current;
                current = hash_pair(&current, &self.zeros[level])
                    .map_err(|_| TreeError::HashFailed)?;
            } else {
                // Right child: pair with the filled left sibling
                current = hash_pair(&self.filled_subtrees[level], &current)
                    .map_err(|_| TreeError::HashFailed)?;
            }
            index /= 2;
        }

        self.root = current;
        self.next_index += 1;

        Ok((leaf_index, self.root))
    }

    /// Get the current Merkle root.
    pub fn root(&self) -> [u8; 32] {
        self.root
    }

    /// Get the number of leaves inserted.
    pub fn len(&self) -> u64 {
        self.next_index
    }

    pub fn is_empty(&self) -> bool {
        self.next_index == 0
    }

    /// Generate a Merkle proof for the leaf at `index`.
    /// Returns (path_elements, path_indices) for circuit input.
    pub fn proof(&self, index: u64) -> Result<MerkleProof, TreeError> {
        if index >= self.next_index {
            return Err(TreeError::IndexOutOfRange(index));
        }

        let mut path_elements = vec![[0u8; 32]; self.depth];
        let mut path_indices = vec![0u8; self.depth];

        // Rebuild the tree layer-by-layer to extract siblings.
        let mut current_layer: Vec<[u8; 32]> = self.leaves.clone();

        // Pad to power of 2 with zeros
        let layer_size = 1usize << self.depth;
        current_layer.resize(layer_size, self.zeros[0]);

        let mut idx = index as usize;

        for level in 0..self.depth {
            // Sibling index
            let sibling_idx = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
            path_elements[level] = current_layer[sibling_idx];
            path_indices[level] = (idx % 2) as u8;

            // Compute next layer
            let mut next_layer = Vec::with_capacity(current_layer.len() / 2);
            for i in (0..current_layer.len()).step_by(2) {
                let h = hash_pair(&current_layer[i], &current_layer[i + 1])
                    .map_err(|_| TreeError::HashFailed)?;
                next_layer.push(h);
            }
            current_layer = next_layer;
            idx /= 2;
        }

        Ok(MerkleProof {
            leaf_index: index,
            path_elements,
            path_indices,
            root: self.root,
        })
    }
}

/// A Merkle inclusion proof.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MerkleProof {
    pub leaf_index: u64,
    /// Sibling hashes at each level (bottom to top).
    pub path_elements: Vec<[u8; 32]>,
    /// Position at each level: 0 = leaf is on the left, 1 = leaf is on the right.
    pub path_indices: Vec<u8>,
    /// The root this proof is valid against.
    pub root: [u8; 32],
}

/// Compute the zero hashes for an empty tree at each level.
/// zeros[0] = 0 (empty leaf)
/// zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
fn compute_zeros(depth: usize) -> Vec<[u8; 32]> {
    let mut zeros = vec![[0u8; 32]; depth + 1];
    for i in 1..=depth {
        zeros[i] = hash_pair(&zeros[i - 1], &zeros[i - 1])
            .expect("Poseidon hash of zero should not fail");
    }
    zeros
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_tree() {
        let tree = MerkleTree::new(4);
        assert_eq!(tree.len(), 0);
        assert!(tree.is_empty());
        assert_ne!(tree.root(), [0u8; 32]); // Root is hash of zeros, not zero itself
    }

    #[test]
    fn test_append_and_root_changes() {
        let mut tree = MerkleTree::new(4);
        let root0 = tree.root();

        let mut leaf1 = [0u8; 32];
        leaf1[31] = 1;
        let (idx, root1) = tree.append(leaf1).unwrap();
        assert_eq!(idx, 0);
        assert_ne!(root0, root1);

        let mut leaf2 = [0u8; 32];
        leaf2[31] = 2;
        let (idx, root2) = tree.append(leaf2).unwrap();
        assert_eq!(idx, 1);
        assert_ne!(root1, root2);
    }

    #[test]
    fn test_merkle_proof_valid() {
        let mut tree = MerkleTree::new(4);

        // Insert a few leaves
        let mut leaves = Vec::new();
        for i in 0..4u8 {
            let mut leaf = [0u8; 32];
            leaf[31] = i + 1;
            tree.append(leaf).unwrap();
            leaves.push(leaf);
        }

        // Generate and verify proof for leaf 0
        let proof = tree.proof(0).unwrap();
        assert_eq!(proof.root, tree.root());
        assert_eq!(proof.path_elements.len(), 4);
        assert_eq!(proof.path_indices.len(), 4);
    }

    #[test]
    fn test_tree_full() {
        let mut tree = MerkleTree::new(2); // max 4 leaves
        for i in 0..4u8 {
            let mut leaf = [0u8; 32];
            leaf[31] = i;
            tree.append(leaf).unwrap();
        }
        let mut leaf = [0u8; 32];
        leaf[31] = 99;
        assert!(tree.append(leaf).is_err());
    }

    #[test]
    fn test_proof_out_of_range() {
        let tree = MerkleTree::new(4);
        assert!(tree.proof(0).is_err());
    }

    #[test]
    fn test_deterministic_roots() {
        let mut tree1 = MerkleTree::new(4);
        let mut tree2 = MerkleTree::new(4);

        let leaf = [42u8; 32];
        tree1.append(leaf).unwrap();
        tree2.append(leaf).unwrap();

        assert_eq!(tree1.root(), tree2.root());
    }
}
