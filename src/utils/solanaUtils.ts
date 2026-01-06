import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, } from '@solana/web3.js';
import {
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import bs58 from 'bs58';
import { SolanaPriceSDK, TokenPrice } from './onchainPrice';


const TOKEN_ACCOUNT_SIZE = 165; // token account data size in bytes

export interface SupplyData {
  success: boolean;
  total_supply: number;
  circulating_supply: number;
  decimals?: number;
  locked_supply?: number;
  excluded_wallets?: { address: string; balance: number }[];
  error?: string;
}

async function lamportsToSol(lamports: number) {
  return lamports / 1_000_000_000;
}

export class SolanaTransferService {
  private connection: Connection;
  private payer: Keypair;

  constructor(rpcUrl: string, payer: Keypair) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.payer = payer;
  }
  
  async getOrCreateATA(
    connection: Connection,
    mint: PublicKey,
    owner: PublicKey,
    payer: Keypair,
    options?: { autoAirdrop?: boolean }
  ): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(mint, owner);
  
    // If the account exists, return it
    try {
      await getAccount(connection, ata);
      return ata;
    } catch (err: any) {
      // TokenAccountNotFoundError — proceed to create
    }
  
    // Compute rent-exempt amount for token account
    const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(
      TOKEN_ACCOUNT_SIZE
    );
  
    // Add a small buffer for fees (transaction fee, etc.)
    const feeBuffer = 5000; // lamports (~0.000005 SOL) — tiny buffer
    const requiredLamports = rentExemptLamports + feeBuffer;
  
    const payerBalance = await connection.getBalance(payer.publicKey);
  
    if (payerBalance < requiredLamports) {
      const msg = `Payer has insufficient SOL to create transaction.
  Payer balance: ${payerBalance} lamports (${(await lamportsToSol(payerBalance)).toFixed(9)} SOL)
  Required (rentExempt + buffer): ${requiredLamports} lamports (${(await lamportsToSol(requiredLamports)).toFixed(9)} SOL)
  Action: Fund the payer wallet with at least ${(await lamportsToSol(requiredLamports)).toFixed(9)} SOL`;
  
      // Optionally auto-airdrop on devnet
      if (options?.autoAirdrop) {
        await connection.getEpochInfo().catch(() => null);
        // best-effort: only request airdrop if network supports it (devnet/testnet)
        try {
          console.log("Attempting airdrop of 0.01 SOL to payer for dev/testing...");
          const airdropSig = await connection.requestAirdrop(
            payer.publicKey,
            10_000_000 // 0.01 SOL
          );
          await connection.confirmTransaction(airdropSig, "confirmed");
        } catch (aErr) {
          console.warn("Airdrop failed or not available:", aErr);
        }
        // re-check balance
        const newBal = await connection.getBalance(payer.publicKey);
        if (newBal < requiredLamports) {
          throw new Error(msg + `\nAfter attempted airdrop, balance is still ${newBal} lamports.`);
        }
      } else {
        throw new Error(msg);
      }
    }
  
    // Build create ATA instruction and send
    const createIx = createAssociatedTokenAccountInstruction(
      payer.publicKey, // payer
      ata, // ata to create
      owner, // owner of ATA
      mint // mint
    );
  
    const tx = new Transaction().add(createIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  
    // Confirm creation
    await getAccount(connection, ata); // if this still fails it will throw
    console.log("ATA created:", ata.toBase58(), "tx:", sig);
    return ata;
  }
  

  /**
   * Transfer native SOL
   */
  async transferSol(to: string, amountSol: number): Promise<{success: boolean, message: string, data: string | null}> {
    try{
      const toPubkey = new PublicKey(to);
      const lamports = amountSol * 1_000_000_000; // 1 SOL = 1e9 lamports

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.payer.publicKey,
          toPubkey,
          lamports,
        })
      );

      const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.payer]);
      if(!txid){
        return {
          success: false,
          message: 'Transaction failed',
          data: null,
        }
      }
      return {
        success: true,
        message: 'Transaction successful',
        data: txid,
      }
    } catch(e: any){
      console.log(e);
      return {
        success: false,
        message: e.message,
        data: null,
      }
    }
  }

  /**
   * Transfer SPL token (any fungible token)
   */
  async transferSplToken(
    tokenMint: string,
    to: string,
    amount: number
  ): Promise<{ success: boolean; message: string; data: string | null }> {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const toPubkey = new PublicKey(to);
  
      // Get mint info to fetch decimals
      const mintInfo = await getMint(this.connection, mintPubkey);
      const decimals = mintInfo.decimals;
  
      const amountInBaseUnits = BigInt(Math.floor(amount * 10 ** decimals));

      const fromATA = await this.getOrCreateATA(this.connection, mintPubkey, this.payer.publicKey, this.payer);
      //console.log("From ATA:", fromATA.toBase58());
      
      const toATA = await this.getOrCreateATA(this.connection, mintPubkey, toPubkey, this.payer);
      //console.log("To ATA:", toATA.toBase58());

      const transferIx = createTransferInstruction(
        fromATA,
        toATA,
        this.payer.publicKey,
        amountInBaseUnits,
        [],
        TOKEN_PROGRAM_ID
      );
  
      // Build transfer instruction
      
  
      const transaction = new Transaction().add(transferIx);
  
      const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.payer]);
  
      if (!txid) {
        return { success: false, message: "Transaction failed", data: null };
      }
  
      return { success: true, message: "Transaction successful", data: txid };
    } catch (e: any) {
      //console.error(e);
      const errorMessage =
        e.message?.match(/Message:\s*(.*?)\s*Logs:/s)?.[1] || e.message;
      return { success: false, message: errorMessage, data: null };
    }
  }
  
}


/**
 * Check if wallet has sufficient SOL for transaction fees
 */
export async function checkFeeBalance(publicKey: PublicKey): Promise<boolean> {
  try {
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const balance = await connection.getBalance(publicKey);
    const balanceInSol = balance / 1e9;
    // Require minimum 0.001 SOL for fees
    return balanceInSol >= 0.001;
  } catch (error) {
    console.error('Error checking fee balance:', error);
    return false;
  }
}

/**
 * Get keypair from private key string
 */
export function getKeypairFromPrivateKey(privateKey: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

/**
 * Get SOL balance for a wallet
 */
export async function getSolBalance(publicKey: PublicKey): Promise<number> {
  try {
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const balance = await connection.getBalance(publicKey);
    return balance / 1e9; // Convert lamports to SOL
  } catch (error) {
    console.error('Error getting SOL balance:', error);
    return 0;
  }
}

/**
 * Validate transaction signature
 */
export function isValidSignature(signature: string): boolean {
  try {
    // Basic validation - should be base58 encoded and proper length
    return signature.length >= 64 && signature.length <= 90;
  } catch {
    return false;
  }
} 

/**
   * Get token supply using @solana/spl-token (most accurate on-chain method).
   * @param mintAddress - The Solana token mint address
   * @param rpcUrl - Solana RPC URL (default: mainnet)
   * @returns Promise with supply information
   */
  export async function  getTokenSupplyFromChain(
    mintAddress: string,
    rpcUrl: string = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
  ): Promise<SupplyData> {
    try {
      const connection = new Connection(rpcUrl, 'confirmed');
      const mintPubkey = new PublicKey(mintAddress);

      // Try Standard Token Program first
      let mintInfo;
      try {
        mintInfo = await getMint(connection, mintPubkey);
      } catch (e) {
        // Fallback to Token-2022 Program
        try {
            mintInfo = await getMint(connection, mintPubkey, "confirmed", TOKEN_2022_PROGRAM_ID);
        } catch (e2) {
            throw e; 
        }
      }

      // Calculate total supply with proper decimals
      // console.log(`[Supply Debug] Raw Supply: ${mintInfo.supply.toString()}, Decimals: ${mintInfo.decimals}`);
      const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

      return {
        success: true,
        total_supply: totalSupply,
        circulating_supply: totalSupply, // Same as total unless we exclude wallets
        decimals: mintInfo.decimals,
        locked_supply: 0,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        total_supply: 0,
        circulating_supply: 0,
        decimals: 0,
        locked_supply: 0
      };
    }
  }



/**
 * Get current SOL price in USD
 * Uses CoinGecko API with simple in-memory caching (1 minute TTL)
 */
let lastSolPrice: number | null = null;
let lastSolPriceTime: number = 0;

export async function getSolPriceInUsd(): Promise<number> {
  const now = Date.now();
  const CACHE_TTL = 60 * 1000; // 1 minute

  if (lastSolPrice && (now - lastSolPriceTime < CACHE_TTL)) {
    return lastSolPrice;
  }

  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    
    if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.statusText}`);
    }
    
    const data = await response.json() as { solana?: { usd?: number } };
    
    if (data?.solana?.usd) {
      lastSolPrice = Number(data.solana.usd);
      lastSolPriceTime = now;
      return lastSolPrice;
    }
    
    return lastSolPrice || 0;
  } catch (error) {
    console.warn('Error fetching SOL price:', error);
    return lastSolPrice || 0;
  }
}

/**
 * Get current token market cap in USD
 * Formula: Price (SOL) * SOL Price (USD) * Supply
 */


export async function getTokenMarketCapInUsd(
  mintAddress: string,
  rpcUrl: string = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
): Promise<number | null> {
  try {
    // 1. Get Token Supply
    const supplyData = await getTokenSupplyFromChain(mintAddress, rpcUrl);
    if (!supplyData.success || supplyData.total_supply === 0) {
      console.warn(`Could not fetch supply for ${mintAddress}:`, supplyData.error);
      return null;
    }

    // 2. Get Token Price in SOL
    const sdk = new SolanaPriceSDK(rpcUrl);
    const tokenPriceData = await sdk.getTokenPrice(mintAddress);
    
    if (!tokenPriceData) {
      console.warn(`Could not fetch price for ${mintAddress}`);
      return null;
    }

    // 3. Get SOL Price in USD
    const solPriceUsd = await getSolPriceInUsd();
    if (solPriceUsd === 0) {
      console.warn('Could not fetch SOL price in USD');
      return null;
    }

    // 4. Calculate Market Cap
    // Market Cap = Token Price (SOL) * SOL Price (USD) * Supply
    const marketCapUsd = tokenPriceData.price * solPriceUsd * supplyData.total_supply;
    
    return marketCapUsd;

  } catch (error) {
    console.error('Error calculating market cap:', error);
    return null;
  }
}

/**
 * Calculate Liquidity in USD from TokenPrice object
 */


export async function getTokenLiquidityInUsd(tokenPrice: TokenPrice): Promise<number> {
    try {
        let liquidityUsd = 0;

        if (tokenPrice.pair === 'SOL' || tokenPrice.quoteMint === 'So11111111111111111111111111111111111111112') {
            // Liquidity is in raw SOL lamports
            const solPrice = await getSolPriceInUsd();
            const liquiditySol = tokenPrice.liquidity / 1_000_000_000;
            liquidityUsd = liquiditySol * solPrice;
        } else if (tokenPrice.pair === 'USDC' || tokenPrice.quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
            // Liquidity is in raw USDC units (6 decimals)
            liquidityUsd = tokenPrice.liquidity / 1_000_000;
        } else {
             // Fallback or unknown pair
             console.warn(`Unknown quote pair for liquidity calc: ${tokenPrice.pair}`);
             liquidityUsd = 0;
        }

        return liquidityUsd;
    } catch (error) {
        console.error("Error calculating liquidity in USD:", error);
        return 0;
    }
}
