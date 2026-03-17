//! Holanc CLI — Interactive REPL for the privacy protocol.

use holanc_client::Wallet;
use holanc_prover::{HolancProver, TransferParams, WithdrawParams, Groth16Proof};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

/// Holds the last generated proof for submission.
static mut LAST_PROOF: Option<Groth16Proof> = None;

fn circuit_dir() -> PathBuf {
    std::env::var("HOLANC_CIRCUIT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./circuits"))
}

fn main() {
    println!("╔══════════════════════════════════════════╗");
    println!("║         Holanc Privacy Protocol          ║");
    println!("║         Interactive CLI v0.1.0           ║");
    println!("╚══════════════════════════════════════════╝");
    println!();
    println!("Initializing Holanc wallet...");
    let mut wallet = Wallet::random();
    let prover = HolancProver::new(circuit_dir());
    println!("Ready. Wallet owner: {}", hex::encode(&wallet.owner()[..8]));
    println!("Circuit dir: {}", circuit_dir().display());
    println!("Type 'help' for commands.\n");

    let stdin = io::stdin();
    loop {
        print!("holanc> ");
        if io::stdout().flush().is_err() {
            break; // stdout closed (broken pipe)
        }

        let mut line = String::new();
        match stdin.lock().read_line(&mut line) {
            Ok(0) | Err(_) => break, // EOF or I/O error
            _ => {}
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts[0] {
            "help" | "h" | "?" => print_help(),

            "deposit" | "d" => cmd_deposit(&mut wallet, &parts),
            "transfer" | "t" => cmd_transfer(&mut wallet, &parts),
            "withdraw" | "w" => cmd_withdraw(&mut wallet, &parts),
            "prove-transfer" | "pt" => cmd_prove_transfer(&wallet, &prover, &parts),
            "prove-withdraw" | "pw" => cmd_prove_withdraw(&wallet, &prover, &parts),
            "submit" => cmd_submit(),

            "balance" | "bal" => cmd_balance(&wallet),
            "notes" | "n" => cmd_notes(&wallet),
            "history" | "hist" => cmd_history(&wallet),

            "tree" => cmd_tree_info(&wallet),
            "root" => {
                println!("Merkle root: {}", hex::encode(wallet.tree().root()));
            }
            "proof" => cmd_proof(&wallet, &parts),

            "export-key" => cmd_export_key(&wallet),
            "import-key" => cmd_import_key(&mut wallet, &parts),

            "status" => cmd_status(&wallet),

            "quit" | "exit" | "q" => {
                println!("Goodbye.");
                break;
            }
            _ => {
                println!("Unknown command: '{}'. Type 'help' for commands.", parts[0]);
            }
        }
    }
}

fn cmd_deposit(wallet: &mut Wallet, parts: &[&str]) {
    if parts.len() < 2 {
        println!("Usage: deposit <amount>");
        return;
    }
    match parts[1].parse::<u64>() {
        Ok(amount) if amount > 0 => {
            let note = wallet.add_deposit_note(amount);
            let leaf_index = note.leaf_index.unwrap_or(0);
            println!(
                "  ✓ Deposited {} lamports",
                amount
            );
            println!("    Leaf index:  {}", leaf_index);
            println!(
                "    Commitment:  {}",
                hex::encode(&note.commitment().0[..16])
            );
            println!(
                "    Merkle root: {}",
                hex::encode(&wallet.tree().root()[..16])
            );
        }
        Ok(_) => println!("Amount must be > 0"),
        Err(_) => println!("Invalid amount: {}", parts[1]),
    }
}

fn cmd_transfer(wallet: &mut Wallet, parts: &[&str]) {
    if parts.len() < 3 {
        println!("Usage: transfer <recipient_hex> <amount> [fee]");
        println!("  recipient_hex: 64-char hex spending key of recipient");
        return;
    }
    let recipient_hex = parts[1];
    if recipient_hex.len() != 64 {
        println!("Recipient must be a 64-character hex string (32 bytes).");
        return;
    }
    let mut recipient = [0u8; 32];
    match hex::decode(recipient_hex) {
        Ok(bytes) if bytes.len() == 32 => recipient.copy_from_slice(&bytes),
        _ => {
            println!("Invalid recipient hex.");
            return;
        }
    }
    let amount: u64 = match parts[2].parse() {
        Ok(a) if a > 0 => a,
        _ => {
            println!("Invalid amount.");
            return;
        }
    };
    let fee: u64 = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

    match wallet.prepare_transfer(recipient, amount, fee) {
        Ok(prepared) => {
            println!("  ✓ Transfer prepared (offline)");
            println!("    Amount: {}, Fee: {}", amount, fee);
            println!(
                "    Input notes:  {} (values: {}, {})",
                2,
                prepared.input_notes[0].value,
                prepared.input_notes[1].value,
            );
            println!(
                "    Output[0]:    {} (to recipient)",
                hex::encode(&prepared.output_notes[0].commitment().0[..8])
            );
            println!(
                "    Output[1]:    {} (change)",
                hex::encode(&prepared.output_notes[1].commitment().0[..8])
            );
            println!("    → Use 'prove transfer' to generate the ZK proof.");
            // Mark inputs spent locally
            let indices: Vec<u64> = prepared
                .input_notes
                .iter()
                .filter_map(|n| n.leaf_index)
                .collect();
            wallet.mark_spent(&indices);
        }
        Err(e) => println!("  ✗ Transfer failed: {}", e),
    }
}

fn cmd_withdraw(wallet: &mut Wallet, parts: &[&str]) {
    if parts.len() < 2 {
        println!("Usage: withdraw <amount> [fee]");
        return;
    }
    let amount: u64 = match parts[1].parse() {
        Ok(a) if a > 0 => a,
        _ => {
            println!("Invalid amount.");
            return;
        }
    };
    let fee: u64 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    match wallet.prepare_withdraw(amount, fee) {
        Ok(prepared) => {
            println!("  ✓ Withdrawal prepared (offline)");
            println!("    Exit value: {}, Fee: {}", prepared.exit_value, fee);
            println!(
                "    Input notes: values ({}, {})",
                prepared.input_notes[0].value,
                prepared.input_notes[1].value,
            );
            println!("    → Use 'prove withdraw' to generate the ZK proof.");
            let indices: Vec<u64> = prepared
                .input_notes
                .iter()
                .filter_map(|n| n.leaf_index)
                .collect();
            wallet.mark_spent(&indices);
        }
        Err(e) => println!("  ✗ Withdrawal failed: {}", e),
    }
}

fn cmd_prove_transfer(wallet: &Wallet, prover: &HolancProver, parts: &[&str]) {
    if parts.len() < 3 {
        println!("Usage: prove-transfer <recipient_hex> <amount> [fee]");
        return;
    }
    let mut recipient = [0u8; 32];
    match hex::decode(parts[1]) {
        Ok(bytes) if bytes.len() == 32 => recipient.copy_from_slice(&bytes),
        _ => { println!("Invalid recipient hex."); return; }
    }
    let amount: u64 = match parts[2].parse() {
        Ok(a) if a > 0 => a,
        _ => { println!("Invalid amount."); return; }
    };
    let fee: u64 = parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);

    let prepared = match wallet.prepare_transfer(recipient, amount, fee) {
        Ok(p) => p,
        Err(e) => { println!("  ✗ Prepare failed: {}", e); return; }
    };

    println!("  Generating Groth16 proof for transfer…");
    let params = TransferParams {
        spending_key: *wallet.owner(),
        input_notes: prepared.input_notes,
        input_proofs: prepared.input_proofs,
        output_notes: prepared.output_notes,
        fee,
    };
    match prover.prove_transfer(&params) {
        Ok(proof) => {
            println!("  ✓ Proof generated!");
            println!("    Public signals: {}", proof.public_signals.len());
            println!("    π_A: {} elements", proof.pi_a.len());
            println!("    → Use 'submit' to send via relayer.");
            // SAFETY: single-threaded CLI, only main thread accesses this
            unsafe { LAST_PROOF = Some(proof); }
        }
        Err(e) => println!("  ✗ Proof generation failed: {}", e),
    }
}

fn cmd_prove_withdraw(wallet: &Wallet, prover: &HolancProver, parts: &[&str]) {
    if parts.len() < 2 {
        println!("Usage: prove-withdraw <amount> [fee]");
        return;
    }
    let amount: u64 = match parts[1].parse() {
        Ok(a) if a > 0 => a,
        _ => { println!("Invalid amount."); return; }
    };
    let fee: u64 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

    let prepared = match wallet.prepare_withdraw(amount, fee) {
        Ok(p) => p,
        Err(e) => { println!("  ✗ Prepare failed: {}", e); return; }
    };

    println!("  Generating Groth16 proof for withdrawal…");
    let params = WithdrawParams {
        spending_key: *wallet.owner(),
        input_notes: prepared.input_notes,
        input_proofs: prepared.input_proofs,
        output_notes: prepared.output_notes,
        exit_value: prepared.exit_value,
        fee,
    };
    match prover.prove_withdraw(&params) {
        Ok(proof) => {
            println!("  ✓ Proof generated!");
            println!("    Public signals: {}", proof.public_signals.len());
            println!("    Exit value: {}", amount);
            println!("    → Use 'submit' to send via relayer.");
            // SAFETY: single-threaded CLI, only main thread accesses this
            unsafe { LAST_PROOF = Some(proof); }
        }
        Err(e) => println!("  ✗ Proof generation failed: {}", e),
    }
}

fn cmd_submit() {
    let proof = unsafe { LAST_PROOF.as_ref() };
    match proof {
        None => {
            println!("  No proof ready. Run 'prove-transfer' or 'prove-withdraw' first.");
        }
        Some(p) => {
            let relayer_url = std::env::var("RELAYER_URL")
                .unwrap_or_else(|_| "http://localhost:3001".into());
            let payload = serde_json::json!({
                "proof": {
                    "pi_a": p.pi_a,
                    "pi_b": p.pi_b,
                    "pi_c": p.pi_c,
                },
                "publicSignals": p.public_signals,
            });
            println!("  Submitting to relayer at {}…", relayer_url);
            println!("  Payload size: {} bytes", serde_json::to_vec(&payload).unwrap_or_default().len());
            println!("  ⚠ HTTP submission requires an async runtime (not included in MVP CLI).");
            println!("  Export payload with: echo '{}' | curl -X POST {}/relay -H 'Content-Type: application/json' -d @-",
                serde_json::to_string(&payload).unwrap_or_default(),
                relayer_url,
            );
        }
    }
}

fn cmd_balance(wallet: &Wallet) {
    let balance = wallet.balance();
    let unspent = wallet.unspent_notes().len();
    let total_notes = wallet.history().len();
    println!("  Balance:       {} lamports", balance);
    println!("  Unspent notes: {}", unspent);
    println!("  Transactions:  {}", total_notes);
}

fn cmd_notes(wallet: &Wallet) {
    let notes = wallet.unspent_notes();
    if notes.is_empty() {
        println!("  No unspent notes.");
        return;
    }
    println!("  {:>6}  {:>12}  {:>16}", "Leaf", "Value", "Commitment");
    println!("  {:─>6}  {:─>12}  {:─>16}", "", "", "");
    for note in notes {
        println!(
            "  {:>6}  {:>12}  {}",
            note.leaf_index.map(|i| i.to_string()).unwrap_or("?".into()),
            note.value,
            hex::encode(&note.commitment().0[..8])
        );
    }
}

fn cmd_history(wallet: &Wallet) {
    let history = wallet.history();
    if history.is_empty() {
        println!("  No transactions yet.");
        return;
    }
    for (i, tx) in history.iter().enumerate() {
        match tx {
            holanc_client::TxRecord::Deposit {
                amount,
                leaf_index,
            } => {
                println!("  [{}] DEPOSIT  amount={} leaf={}", i, amount, leaf_index);
            }
            holanc_client::TxRecord::Send {
                amount,
                fee,
                nullifiers,
            } => {
                println!(
                    "  [{}] SEND     amount={} fee={} nullifier={}…",
                    i,
                    amount,
                    fee,
                    hex::encode(&nullifiers[0][..4])
                );
            }
            holanc_client::TxRecord::Withdraw {
                amount,
                fee,
                nullifiers,
            } => {
                println!(
                    "  [{}] WITHDRAW amount={} fee={} nullifier={}…",
                    i,
                    amount,
                    fee,
                    hex::encode(&nullifiers[0][..4])
                );
            }
        }
    }
}

fn cmd_tree_info(wallet: &Wallet) {
    let tree = wallet.tree();
    let root = tree.root();
    let next_index = tree.next_index();
    let depth = tree.depth();

    println!("  Merkle Tree Info");
    println!("  ────────────────");
    println!("  Depth:      {}", depth);
    println!("  Leaves:     {}", next_index);
    println!("  Capacity:   {}", 1u64 << depth);
    println!(
        "  Root:       {}",
        hex::encode(&root[..16])
    );
    println!(
        "  Full root:  {}",
        hex::encode(root)
    );
}

fn cmd_proof(wallet: &Wallet, parts: &[&str]) {
    if parts.len() < 2 {
        println!("Usage: proof <leaf_index>");
        println!("  Generates a Merkle inclusion proof for the given leaf.");
        return;
    }
    let index: u64 = match parts[1].parse() {
        Ok(i) => i,
        Err(_) => {
            println!("Invalid leaf index.");
            return;
        }
    };
    match wallet.tree().proof(index) {
        Ok(proof) => {
            println!("  Merkle Proof for leaf {}", index);
            println!("  Root:     {}", hex::encode(proof.root));
            println!("  Path indices: {:?}", proof.path_indices);
            println!("  Path elements:");
            for (level, elem) in proof.path_elements.iter().enumerate() {
                println!("    [{}] {}", level, hex::encode(&elem[..16]));
            }
        }
        Err(e) => println!("  ✗ Proof error: {}", e),
    }
}

fn cmd_export_key(wallet: &Wallet) {
    let owner = wallet.owner();
    println!("  Spending key (hex): {}", hex::encode(owner));
    println!("  ⚠ Keep this key safe! Anyone with it can spend your notes.");
}

fn cmd_import_key(wallet: &mut Wallet, parts: &[&str]) {
    if parts.len() < 2 {
        println!("Usage: import-key <64_char_hex>");
        println!("  ⚠ This will reset the wallet. Existing notes are lost.");
        return;
    }
    let hex_str = parts[1];
    if hex_str.len() != 64 {
        println!("Key must be a 64-character hex string (32 bytes).");
        return;
    }
    match hex::decode(hex_str) {
        Ok(bytes) if bytes.len() == 32 => {
            let mut key_bytes = [0u8; 32];
            key_bytes.copy_from_slice(&bytes);
            *wallet = Wallet::new(holanc_note::keys::SpendingKey::from_bytes(key_bytes));
            println!("  ✓ Wallet imported. Owner: {}", hex::encode(&key_bytes[..8]));
            println!("  Note: local notes and tree are reset.");
        }
        _ => println!("Invalid hex key."),
    }
}

fn cmd_status(wallet: &Wallet) {
    println!("  Holanc Privacy Protocol — Local Status");
    println!("  ──────────────────────────────────────");
    println!("  Owner:       {}…", hex::encode(&wallet.owner()[..8]));
    println!("  Balance:     {} lamports", wallet.balance());
    println!("  Notes:       {} unspent", wallet.unspent_notes().len());
    println!("  Tree leaves: {}", wallet.tree().next_index());
    println!(
        "  Merkle root: {}…",
        hex::encode(&wallet.tree().root()[..8])
    );
}

fn print_help() {
    println!("╭──────────────────────────────────────────────────────────╮");
    println!("│ Holanc CLI Commands                                     │");
    println!("├──────────────────────────────────────────────────────────┤");
    println!("│ Wallet Operations                                       │");
    println!("│   deposit <amount>              — Deposit into pool     │");
    println!("│   transfer <recipient> <amount> — Prepare transfer      │");
    println!("│   withdraw <amount> [fee]       — Prepare withdrawal    │");
    println!("│                                                         │");
    println!("│ Proving & Submission                                    │");
    println!("│   prove-transfer / pt <recip> <amt> — Generate proof   │");
    println!("│   prove-withdraw / pw <amt> [fee]   — Generate proof   │");
    println!("│   submit                            — Submit to relayer│");
    println!("│                                                         │");
    println!("│ Wallet Info                                             │");
    println!("│   balance / bal     — Show wallet balance               │");
    println!("│   notes / n         — List unspent notes                │");
    println!("│   history / hist    — Show transaction history          │");
    println!("│   status            — Overview of wallet state          │");
    println!("│                                                         │");
    println!("│ Merkle Tree                                             │");
    println!("│   tree              — Merkle tree info                  │");
    println!("│   root              — Show current Merkle root          │");
    println!("│   proof <index>     — Merkle proof for leaf index       │");
    println!("│                                                         │");
    println!("│ Key Management                                          │");
    println!("│   export-key        — Show spending key (hex)           │");
    println!("│   import-key <hex>  — Import spending key (resets tree) │");
    println!("│                                                         │");
    println!("│   help / h / ?      — Show this help                   │");
    println!("│   quit / exit / q   — Exit CLI                         │");
    println!("╰──────────────────────────────────────────────────────────╯");
}
