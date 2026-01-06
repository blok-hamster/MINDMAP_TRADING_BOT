import { Keypair, Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from "bs58";
import { SolanaTracker } from "solana-swap";
import { config } from 'dotenv';

config();


interface PerformSwapOptions {
  fromToken: string;
  toToken: string;
  amount: number;
  slippage: number;
  payer: string;
  priorityFee: number;
}

interface IRateResponse {
  amountIn: number;
  amountOut: number;
  minAmountOut: number;
  currentPrice: number;
  executionPrice: number;
  priceImpact: number;
  fee: number;
  baseCurrency: {
    decimals: number;
    mint: string;
  };
  quoteCurrency: {
    decimals: number;
    mint: string;
  };
  platformFee: number;
  platformFeeUI: number;
}

export class SolanaTrackerSwapClient {
  private readonly rpcUrl: string;
  private readonly privateKey: string;
  private readonly apiKey: string;
  private connection
  
  constructor({apiKey = process.env.SOLANA_TRACKER_API_KEY!, rpcUrl = process.env.SOLANA_RPC_URL!, privateKey}: {apiKey: string, rpcUrl: string, privateKey: string}) {
    this.rpcUrl = rpcUrl;
    this.privateKey = privateKey;
    this.apiKey = apiKey;
    this.connection = new Connection(rpcUrl);
  }

  //Trump token: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"
  async getTokenBalance({mint}:{mint?: string}) {
      try{  
        const keypair = Keypair.fromSecretKey(bs58.decode(this.privateKey));
        //const owner = new PublicKey("8ezggN9N1QM6a6jBgqmdRAGSMQZ25mDw3dyWWbRhNhhp")
        const owner = keypair.publicKey
        
        const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, {
          programId: TOKEN_PROGRAM_ID 
        });

        let infos: Array<{account: string, mint: string, balance: number}> = []
        accounts.value.forEach(({ pubkey, account }) => {
          const info = account.data.parsed.info;
          infos.push({account: pubkey.toBase58(), mint: info.mint, balance: info.tokenAmount.uiAmount})
        });

        let balanceInfo: {account: string, mint: string, balance: number} = {account: '', mint: '', balance: 0};
        infos.map(x => {
          if(x.mint === mint){
            balanceInfo = x
          }
        })

        return {status: true, data: balanceInfo, message: 'token blance retrived'}
      }catch(e){
        console.log((e as Error))
        return {status: false, data: null, message: 'error geting token balance'}
      }
  }


  async performSwap({fromToken, toToken, amount, slippage, payer, priorityFee}: PerformSwapOptions) {
    try {
      const keypair = Keypair.fromSecretKey(bs58.decode(this.privateKey));
      const solanaTracker = new SolanaTracker(
        keypair,
        this.rpcUrl,
        this.apiKey
      );

      const balance = await this.connection.getBalance(keypair.publicKey);
    
      // Get the rate information
      const rate = await solanaTracker.getRate(fromToken, toToken, amount, slippage);
    
      // Validate if the wallet has enough balance
      const balanceValidation = await this.validateSwapBalance(balance, rate);
    
      if (!balanceValidation.canProceed) {
        return {
          success: false,
          message: `Insufficient balance. Need ${balanceValidation.totalRequired} SOL but have ${balanceValidation.balanceInSol} SOL (${(balanceValidation.percentageCovered || 0).toFixed(2)}% covered)`,
          data: {
            txid: null,
            rateDetails: balanceValidation.details,
            swapResponse: null
          }
        };
      }

      if(balanceValidation.details?.priceImpact && balanceValidation.details.priceImpact > 1){
        return {
          success: false,
          message: "Price impact is too high",
          data: {
            txid: null,
            rateDetails: balanceValidation.details,
            swapResponse: null
          }
        }
      }
    
      // Proceed with the swap if balance is sufficient
      const swapResponse = await solanaTracker.getSwapInstructions(fromToken, toToken, amount, slippage, payer, priorityFee, false, {
        fee: {
            wallet: process.env.FEE_WALLET_ADDRESS!,
            percentage: 0.5  // 0.5% fee
          },
          feeType: "add"
      });
    
      const txid = await solanaTracker.performSwap(swapResponse, {
        sendOptions: { skipPreflight: true },
        confirmationRetries: 30,
        confirmationRetryTimeout: 500,
        lastValidBlockHeightBuffer: 150,
        resendInterval: 1000,
        confirmationCheckInterval: 1000,
        commitment: "processed",
        skipConfirmationCheck: true
      });

      // Wait for transaction to propagate to mempool before checking status
      //console.log(`Transaction ${txid} submitted, waiting for mempool propagation...`);
      await new Promise(resolve => setTimeout(resolve, 400));

      // Check if transaction was successful
      const transactionSuccess = await this.checkTransactionSuccess(txid);
      
      if (!transactionSuccess.success) {
        return {
          success: false,
          message: `Transaction failed: ${transactionSuccess.error}`,
          data: {
            txid: txid,
            rateDetails: balanceValidation.details,
            swapResponse: null
          }
        };
      }

      // Get execution price from the confirmed transaction
      if(txid && balanceValidation.details){
        const executionPrice = swapResponse.rate.executionPrice;
        balanceValidation.details.executionPrice = executionPrice;
      }
    
      const swapResult = {
        txid: txid,
        swapResponse: swapResponse,
        rateDetails: balanceValidation.details
      };
    
      return {
        success: true,
        message: "Swap successful and confirmed",
        data: swapResult
      };
    } catch (error: any) {
      console.log("error", error.message)
      console.log("error", error.response.data)
      return {
        success: false,
        message: error.message,
        data: null
      }
    }
  }

  /**
   * Checks if a transaction was successful by verifying its confirmation status
   * @param txid The transaction ID to check
   * @returns An object indicating if the transaction was successful
   */
  async checkTransactionSuccess(txid: string): Promise<{success: boolean, error?: string}> {
    try {
      const maxRetries = 4;
      const retryInterval = 400; // 2 seconds
      
      for (let i = 0; i < maxRetries; i++) {
        try {
          const transaction = await this.connection.getTransaction(txid, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
          });

          if (transaction) {
            // Check if transaction succeeded (no error)
            if (transaction.meta?.err === null) {
              console.log(`Transaction ${txid} confirmed successfully`);
              return { success: true };
            } else {
              console.log(`Transaction ${txid} failed with error:`, transaction.meta?.err);
              return { 
                success: false, 
                error: `Transaction failed: ${JSON.stringify(transaction.meta?.err)}` 
              };
            }
          }

          // Transaction not found yet, wait and retry
          //TODO: handle transaction errors properly
          //console.log(`Transaction ${txid} not confirmed yet, retrying... (${i + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryInterval));
          
        } catch (innerError) {
          console.log(`Error checking transaction ${txid} on attempt ${i + 1}:`, (innerError as Error).message);
          if (i === maxRetries - 1) {
            throw innerError;
          }
          await new Promise(resolve => setTimeout(resolve, retryInterval));
        }
      }

      // If we've exhausted all retries
      return { 
        success: false, 
        error: `Transaction confirmation timeout after ${maxRetries} attempts` 
      };

    } catch (error) {
      console.error(`Error checking transaction success for ${txid}:`, error);
      return { 
        success: false, 
        error: `Failed to verify transaction: ${(error as Error).message}` 
      };
    }
  }

  /**
   * Validates if a wallet has sufficient balance to perform a swap
   * @param balance The wallet's current balance in lamports
   * @param rateResponse The response from solanaTracker.getRate()
   * @returns An object indicating if the balance is sufficient and any relevant details
   */
  async validateSwapBalance(balance: number, rateResponse: IRateResponse) {
    try {
      // Convert balance from lamports to SOL (1 SOL = 1e9 lamports)
      const balanceInSol = balance / 1e9;

      if(rateResponse.quoteCurrency.mint === "So11111111111111111111111111111111111111112"){
        return {
          canProceed: true,
          balanceInSol,
          totalRequired: rateResponse.amountIn,
          details: {
            priceImpact: 0,
            executionPrice: rateResponse.executionPrice,
            amountIn: rateResponse.amountIn,
            platformFee: rateResponse.platformFeeUI,
            baseCurrency: rateResponse.baseCurrency.mint,
            quoteCurrency: rateResponse.quoteCurrency.mint,
          }
        }
      }
      
      // Calculate total required amount including fees
      const totalRequired = rateResponse.amountIn + rateResponse.platformFeeUI;
      
      // Check if the wallet has enough balance
      const hasEnoughBalance = balanceInSol >= totalRequired;
      
      // Calculate how much more is needed if balance is insufficient
      const deficit = hasEnoughBalance ? 0 : totalRequired - balanceInSol;
      
      // Calculate the percentage of required amount that the wallet has
      const percentageCovered = hasEnoughBalance ? 100 : (balanceInSol / totalRequired) * 100;
      
      return {
        canProceed: hasEnoughBalance,
        balanceInSol,
        totalRequired,
        deficit,
        percentageCovered,
        details: {
          amountIn: rateResponse.amountIn,
          platformFee: rateResponse.platformFeeUI,
          baseCurrency: rateResponse.baseCurrency.mint,
          quoteCurrency: rateResponse.quoteCurrency.mint,
          priceImpact: rateResponse.priceImpact,
          executionPrice: rateResponse.executionPrice
        }
      };
    } catch (error) {
      console.error("Error validating swap balance:", error);
      return {
        canProceed: false,
        error: (error as Error).message || "Unknown error during balance validation",
        balanceInSol: balance / 1e9,
        totalRequired: 0,
        deficit: 0,
        percentageCovered: 0,
        details: null
      };
    }
  }

}
