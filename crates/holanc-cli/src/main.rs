//! Holanc CLI — Interactive REPL for the privacy protocol.

use holanc_client::Wallet;
use std::io::{self, BufRead, Write};

fn main() {
    println!("Initializing Holanc wallet...");
    let mut wallet = Wallet::random();
    println!("Ready. Wallet owner: {}", hex::encode(&wallet.owner()[..8]));
    println!("Type 'help' for commands.\n");

    let stdin = io::stdin();
    loop {
        print!("holanc> ");
        io::stdout().flush().unwrap();

        let mut line = String::new();
        if stdin.lock().read_line(&mut line).unwrap() == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts[0] {
            "help" => print_help(),
            "deposit" => {
                if parts.len() < 2 {
                    println!("Usage: deposit <amount>");
                    continue;
                }
                match parts[1].parse::<u64>() {
                    Ok(amount) => {
                        let note = wallet.add_deposit_note(amount);
                        let leaf_index = note.leaf_index.unwrap_or(0);
                        println!(
                            "Deposited {}. Leaf index: {}. Commitment: {}",
                            amount,
                            leaf_index,
                            hex::encode(&note.commitment().0[..8])
                        );
                    }
                    Err(_) => println!("Invalid amount"),
                }
            }
            "balance" => {
                println!("Wallet balance: {}", wallet.balance());
                println!("Unspent notes: {}", wallet.unspent_notes().len());
            }
            "history" => {
                for (i, tx) in wallet.history().iter().enumerate() {
                    println!("[{}] {:?}", i, tx);
                }
                if wallet.history().is_empty() {
                    println!("No transactions yet.");
                }
            }
            "notes" => {
                for note in wallet.unspent_notes() {
                    println!(
                        "  leaf={:?} value={} commitment={}",
                        note.leaf_index,
                        note.value,
                        hex::encode(&note.commitment().0[..8])
                    );
                }
            }
            "root" => {
                println!("Merkle root: {}", hex::encode(wallet.tree().root()));
            }
            "quit" | "exit" => {
                println!("Goodbye.");
                break;
            }
            _ => {
                println!("Unknown command: {}. Type 'help' for commands.", parts[0]);
            }
        }
    }
}

fn print_help() {
    println!("Commands:");
    println!("  deposit <amount>  — Deposit into the privacy pool");
    println!("  balance           — Show wallet balance");
    println!("  notes             — List unspent notes");
    println!("  history           — Show transaction history");
    println!("  root              — Show current Merkle root");
    println!("  help              — Show this help");
    println!("  quit              — Exit");
}
