import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import * as dotenv from 'dotenv';
import path from 'path';

// Load env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function main() {
    const tokenMintStr = process.argv[2];
    if (!tokenMintStr) {
        console.error('Please provide a Token Mint Address');
        console.error('Usage: npx ts-node src/scripts/inspect_launchpad.ts <TOKEN_MINT>');
        process.exit(1);
    }

    const mint = new PublicKey(tokenMintStr);
    console.log(`\n🔍 Inspecting Raydium Launchpad for Token: ${mint.toBase58()}`);

    // Raydium LaunchLab Program
    const LAUNCHLAB_ID = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
    // 2. Strategy: Scan using getProgramAccounts with Memcmp (Reverse Lookup)
    // We don't know the seeds, but we know the account MUST store the Mint address somewhere.

    const connection = new Connection(RPC_URL, 'confirmed');

    // 0. Analyze Mint Itself
    console.log(`\n🪙 Analyzing Mint: ${mint.toBase58()}`);
    const mintInfo = await connection.getAccountInfo(mint);
    if (mintInfo) {
        // Mint Layout:
        // [0:4] Mint Authority Option
        // [4:36] Mint Authority
        // [36:44] Supply (u64)
        // [44] Decimals (u8)
        const supply = new BN(mintInfo.data.subarray(36, 44), 'le');
        const decimals = mintInfo.data[44];
        console.log(`  Supply (Raw): ${supply.toString()}`);
        console.log(`  Decimals: ${decimals}`);
        console.log(`  Supply (UI): ${parseFloat(supply.toString()) / Math.pow(10, decimals)}`);
    } else {
        console.log('  ❌ Mint Account Not Found');
        return;
    }
    
    console.log('\n🕵️‍♂️ Scanning for accounts owned by LaunchLab containing the Mint...');

    // 3. Strategy: Transaction History Analysis (The "Creation" Transaction)
    // We fetch the very first transaction involving the Mint. This is likely the "create + buy" transaction.
    // In that transaction, the LaunchData/BondingCurve account MUST be present and written to.
    
    console.log('\n📜 Analyzing Mint Transaction History...');

    try {
        // Get the oldest signature (limit 1, working backwards)
        // Note: For very active tokens, this might need more robust paging, but for inspecting a specific launchpad token,
        // usually the creation is within the last 1000 txs or we just fetch the earliest.
        // Actually, fetching the *last* signature from the end is hard without walking back.
        // But typically, standard RPC 'before' pagination works.
        
        // Let's just grab the last 20 signatures and look for the one that interacts with LaunchLab
        const signatures = await connection.getSignaturesForAddress(mint, { limit: 20 });
        
        // If the token is old, we might need to go deeper. 
        // But usually, we can just find *any* transaction that involves LaunchLab.
        // If the token is trading on LaunchLab, LaunchLab MUST be in the transaction accounts.
        
        // let targetSig: string | null = null;
        let launchLabInteractionFound = false;

        // Iterate through recent transactions to find one involving LaunchLab
        for (const sigInfo of signatures) {
            if (sigInfo.err) continue;
            
            const tx = await connection.getParsedTransaction(sigInfo.signature, {
                maxSupportedTransactionVersion: 0
            });

            if (!tx) continue;

            // Check if this transaction interacts with LaunchLab program
            const involvesLaunchLab = tx.transaction.message.accountKeys.some(
                (k: any) => k.pubkey.toBase58() === LAUNCHLAB_ID.toBase58()
            );

            if (involvesLaunchLab) {
                console.log(`\n✅ Found LaunchLab interaction in tx: ${sigInfo.signature}`);
                launchLabInteractionFound = true;
                
                // Inspect accounts in this transaction to find the one owned by LaunchLab
                // The Bonding Curve account should be:
                // 1. Owned by LaunchLab
                // 2. Writable
                // 3. Size > 0
                
                // We need 'getParsedTransaction' to give us account ownership if possible, 
                // but standard response has accountKeys. 
                // We will have to fetch account info for candidates.
                
                const candidates = tx.transaction.message.accountKeys.filter((k: any) => k.writable);
                
                for (const candidate of candidates) {
                    const candidatePubkey = candidate.pubkey;
                    // Skip mint, payer, standard programs
                    if (candidatePubkey.equals(mint)) continue;
                    
                    const info = await connection.getAccountInfo(candidatePubkey);
                    if (info && info.owner.equals(LAUNCHLAB_ID)) {
                        console.log(`\n🎯 CANDIDATE FOUND via Transaction Analysis!`);
                        console.log(`  Account: ${candidatePubkey.toBase58()}`);
                        console.log(`  Owner: ${info.owner.toBase58()}`);
                        console.log(`  Data Len: ${info.data.length}`);
                        
                        await analyzeAccountData(info.data);
                        return;
                    }
                }
            }
        }
        
        if (!launchLabInteractionFound) {
            console.log('⚠️ No recent transactions involving LaunchLab found. Token might be graduated or inactive?');
            console.log('Try to fetch *earliest* transaction if possible (requires more code usually).');
        }

    } catch (e: any) {
        console.log(`Error analyzing history: ${e.message}`);
    }

    console.log('\n❌ Failed to find account via History lookup.');
}

async function analyzeAccountData(data: Buffer) {
    // 1. Find Mint Offset
    const mintStr = process.argv[2] || '6YxpYE2aHPF7PqPuH8J2J66vQPMwzyhMva8YVDzVbonk';
    const mint = new PublicKey(mintStr);
    const mintBytes = mint.toBuffer();
    
    let mintOffset = -1;
    // Simple scan
    for (let i = 0; i < data.length - 32; i++) {
        if (data.subarray(i, i + 32).equals(mintBytes)) {
            mintOffset = i;
            break;
        }
    }

    if (mintOffset !== -1) {
        console.log(`\n🔑 MINT ADDRESS FOUND AT OFFSET: ${mintOffset} (0x${mintOffset.toString(16)})`);
    } else {
        console.log('\n❌ Mint address NOT found in account data.');
    }

    // 1b. Check for USD1 Mint
    const usd1 = new PublicKey('USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB');
    
    // Check offsets
    let usd1Offset = -1;
    const usd1Bytes = usd1.toBuffer();
    for (let i = 0; i < data.length - 32; i++) {
        if (data.subarray(i, i + 32).equals(usd1Bytes)) {
            usd1Offset = i;
            break;
        }
    }

    if (usd1Offset !== -1) {
        console.log(`\n✅ USD1 MINT FOUND AT OFFSET: ${usd1Offset} (0x${usd1Offset.toString(16)})`);
    } else {
        console.log('\nps USD1 Mint NOT found in data.');
    }

    // 1c. Check if Bonding Curve OWNS a USD1 Token Account (Vault)
    // The Bonding Curve Account is 'acc.pubkey' (we need to get it from the candidates loop or pass it)
    // Here we are analyzing data buffer, we don't have the pubkey handy in this function scope easily 
    // without refactoring. 
    // Let's print the suggestion to check externally or pass the pubkey.
    console.log('\n🔎 Suggestion: Check if this account owns a Token Account for USD1.');

    console.log('\n🔢 Scanning for vToken Candidates (0.5B - 1.5B tokens):');
    
    // Check 6 decimals (1e15) and 9 decimals (1e18)
    const ranges = [
        { min: new BN('500000000000000'), max: new BN('1500000000000000'), label: '6 Decimals' },
        { min: new BN('500000000000000000'), max: new BN('1500000000000000000'), label: '9 Decimals' }
    ];

    for (let i = 0; i < data.length - 8; i += 4) {
        const val = new BN(data.subarray(i, i + 8), 'le');
        
        for (const range of ranges) {
            if (val.gt(range.min) && val.lt(range.max)) {
                console.log(`Potential vTokens at Offset ${i}: ${val.toString()} (${range.label})`);
            }
        }
        
        // Also check vSOL again just to be sure
         const minSol = new BN('10000000000'); // 10 SOL
         const maxSol = new BN('1000000000000'); // 1000 SOL
         if (val.gt(minSol) && val.lt(maxSol)) {
             console.log(`Potential vSOL at Offset ${i}: ${val.toString()}`);
         }
         
         if (i === 76) {
             console.log(`\n👉 OFFSET 76 VALUE: ${val.toString()} (Raw) | ${val.div(new BN(1000000000)).toString()} SOL`);
         }
    }
}

main().catch(console.error);
