import * as crypto from "crypto";

// Transfer class with validation for positive amount and preventing self-transfers
class Transfer {
  constructor(
    public amount: number,
    public payer: string, // Public Key of the sender
    public payee: string // Public Key of the receiver
  ) {
    if (amount <= 0) {
      throw new Error("Transfer amount must be positive.");
    }

    if (payer === payee) {
      throw new Error("Cannot send money to yourself.");
    }
  }

  toString() {
    return JSON.stringify(this);
  }
}

// Credit class (negative amounts allowed for penalties)
class Credit {
  constructor(
    public amount: number,
    public receiver: string, // Public Key of the receiver for credits/penalties
    public reason: string // Reason for reward or penalty
  ) {}

  toString() {
    return JSON.stringify(this);
  }
}

// AccountBalance class that holds balance for each account
class AccountBalance {
  constructor(public publicKey: string, public balance: number = 0) {}

  increase(amount: number) {
    this.balance += amount;
  }

  decrease(amount: number) {
    if (this.balance > amount) {
      this.balance -= amount;
    }
  }
}

// CreditScore class to hold credit score for each account
class CreditScore {
  constructor(public publicKey: string, public score: number = 500) {}

  increase(amount: number) {
    this.score += amount;
  }

  decrease(amount: number) {
    this.score -= amount;
  }
}

// Block class with both Transfer and Credit functionality
class Block {
  public nonce: number = Math.round(Math.random() * 999999);

  constructor(
    public index: number | string,
    public prevHash: string | null,
    public transfers: Transfer[], // Separate array for transfers
    public accountBalances: AccountBalance[], // List of updated account balances
    public creditLedger: Credit[], // Separate array for rewards and penalties
    public creditScores: CreditScore[], // List of updated credit scores
    public timestamp = Date.now()
  ) {}

  get hash() {
    const str = JSON.stringify(this);
    const hash = crypto.createHash("SHA256");
    hash.update(str).end();
    return hash.digest("hex");
  }
}

class Chain {
  public static instance = new Chain();

  chain: Block[] = []; // Initially no blocks (Genesis Block created on demand)
  transferPool: Transfer[] = []; // Pool to store pending transfers
  blockchainMintAddress = "Blockchain Mint"; // Special mint address

  get lastBlock() {
    return this.chain[this.chain.length - 1];
  }

  // Mine a block
  mine(nonce: number) {
    let solution = 0;
    console.log("⛏️ Mining...");

    while (true) {
      const hash = crypto.createHash("MD5");
      hash.update((nonce + solution).toString()).end();

      const attempt = hash.digest("hex");

      if (attempt.substring(0, 5) === "00000") {
        console.log(`Solved: ${solution}`);
        return solution;
      }
      solution += 1;
    }
  }

  // Helper to find the latest balance for a user by going backwards through the chain
  getLatestBalanceFromChain(publicKey: string): number {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      const accountBalance = block.accountBalances.find(
        (ab) => ab.publicKey === publicKey
      );
      if (accountBalance) {
        return accountBalance.balance;
      }
    }
    return 0; // Default balance is 0 if no prior transactions
  }

  // Helper to find the latest credit score for a user by going backwards through the chain
  getLatestCreditScoreFromChain(publicKey: string): number {
    let creditScore = 500; // Default credit score
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      const creditScoreInBlock = block.creditScores.find(
        (cs) => cs.publicKey === publicKey
      );
      if (creditScoreInBlock) {
        creditScore = creditScoreInBlock.score;
        break; // Use the latest found credit score
      }
    }
    return creditScore;
  }

  // Helper to check if the payer was involved in the last 1 or 2 blocks
  wasPayerInLastBlocks(publicKey: string, blocksToCheck: number): boolean {
    const chainLength = this.chain.length;
    for (
      let i = chainLength - 1;
      i >= Math.max(0, chainLength - blocksToCheck);
      i--
    ) {
      const block = this.chain[i];
      if (block.transfers.some((t) => t.payer === publicKey)) {
        return true;
      }
    }
    return false;
  }

  // Apply a transfer and update account balances
  applyTransfer(transfer: Transfer, block: Block) {
    const payerBalance = this.getLatestBalanceFromChain(transfer.payer);
    const payeeBalance = this.getLatestBalanceFromChain(transfer.payee);

    // If the payer does not have enough balance and is not the blockchain mint, return without processing
    if (
      payerBalance < transfer.amount &&
      transfer.payer !== this.blockchainMintAddress
    ) {
      console.log(
        `Insufficient funds: ${transfer.payer} has ${payerBalance}, tried to send ${transfer.amount}.`
      );
      return; // Don't process the transfer
    }

    // Ensure the Blockchain Mint does not accumulate a balance
    if (transfer.payer !== this.blockchainMintAddress) {
      const newPayerBalance = payerBalance - transfer.amount;
      const payerAccount = new AccountBalance(transfer.payer, newPayerBalance);
      block.accountBalances.push(payerAccount);
    }

    const newPayeeBalance = payeeBalance + transfer.amount;
    const payeeAccount = new AccountBalance(transfer.payee, newPayeeBalance);
    block.accountBalances.push(payeeAccount);
  }

  // Add a transfer to the pool
  addTransferToPool(transfer: Transfer) {
    this.transferPool.push(transfer);
  }

  // Mint tokens to a given public key and add to the transfer pool
  mintTokens(mintAmount: number, receiverPublicKey: string) {
    const mintTransfer = new Transfer(
      mintAmount,
      this.blockchainMintAddress,
      receiverPublicKey
    );
    this.addTransferToPool(mintTransfer);
    console.log(`Minted ${mintAmount} tokens to ${receiverPublicKey}`);
  }

  // Consolidate balances before pushing the block
  consolidateAccountBalances(
    accountBalances: AccountBalance[],
    transfers: Transfer[]
  ): AccountBalance[] {
    const balanceMap: { [key: string]: number } = {};

    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      block.accountBalances.forEach((account) => {
        if (account.publicKey !== this.blockchainMintAddress) {
          if (!balanceMap[account.publicKey]) {
            balanceMap[account.publicKey] = account.balance;
          }
        }
      });
    }

    transfers.forEach((transfer) => {
      if (transfer.payer !== this.blockchainMintAddress) {
        if (balanceMap[transfer.payer] !== undefined) {
          balanceMap[transfer.payer] -= transfer.amount;
        } else {
          balanceMap[transfer.payer] = -transfer.amount;
        }
      }

      if (balanceMap[transfer.payee] !== undefined) {
        balanceMap[transfer.payee] += transfer.amount;
      } else {
        balanceMap[transfer.payee] = transfer.amount;
      }
    });

    return Object.keys(balanceMap).map(
      (key) => new AccountBalance(key, balanceMap[key])
    );
  }

  // Consolidate credit scores and add rewards or penalties
  consolidateCreditScores(
    creditScores: CreditScore[],
    creditLedger: Credit[]
  ): CreditScore[] {
    const scoreMap: { [key: string]: number } = {};

    // Process credits in the current block's ledger to update the score map
    creditLedger.forEach((credit) => {
      if (scoreMap[credit.receiver]) {
        scoreMap[credit.receiver] += credit.amount;
      } else {
        scoreMap[credit.receiver] = credit.amount;
      }
    });

    // Now, for each unique receiver in the ledger, we get their latest credit score from the chain
    const updatedScores = Object.keys(scoreMap).map((publicKey) => {
      const mostRecentCreditScore =
        this.getLatestCreditScoreFromChain(publicKey);
      // Update the score by adding the current block's ledger amounts to the most recent score
      const updatedScore = mostRecentCreditScore + scoreMap[publicKey];
      return new CreditScore(publicKey, updatedScore);
    });

    return updatedScores;
  }

  // Reward miner credits and add to credit ledger
  rewardMiner(minerWallet: Wallet, block: Block) {
    const miningReward = 100;
    const minerCredit = new Credit(
      miningReward,
      minerWallet.publicKey,
      "Block Reward"
    );
    block.creditLedger.push(minerCredit);
  }

  // Apply credit earning rules
  applyCreditRewards(transfer: Transfer, block: Block) {
    if (transfer.payer !== this.blockchainMintAddress) {
      // Check if the payer had transactions in the last block or two blocks ago
      const payerInLast1Block = this.wasPayerInLastBlocks(transfer.payer, 1);
      const payerInLast2Blocks = this.wasPayerInLastBlocks(transfer.payer, 2);

      if (payerInLast2Blocks) {
        // Subtract 50 credits if the payer was in the last 2 blocks
        block.creditLedger.push(
          new Credit(-50, transfer.payer, "Penalty for frequent transactions")
        );
      } else if (!payerInLast1Block) {
        // Reward both payer and payee if they weren't in the last block
        block.creditLedger.push(
          new Credit(10, transfer.payer, "Using The Network")
        );
        block.creditLedger.push(
          new Credit(10, transfer.payee, "Using The Network")
        );
      } else {
        // No rewards if the payer was in the last block
        console.log(
          `Payer ${transfer.payer} was involved in a transaction in the last block, no credits rewarded.`
        );
      }
    }
  }

  // Mine a block
  mineBlock(minerWallet: Wallet) {
    const minerCreditScore = this.getLatestCreditScoreFromChain(
      minerWallet.publicKey
    );

    if (this.chain.length > 0 && minerCreditScore < 1000) {
      console.log(
        "⛔ Mining restriction: Miner requires at least 1000 credit score."
      );
      return;
    }

    if (this.chain.length === 0) {
      console.log("🚀 Creating the Genesis Block...");

      const genesisBlock = new Block(
        "Genesis",
        null,
        [], // No transfers
        [], // No account balances
        [new Credit(500, minerWallet.publicKey, "Genesis Block Reward")], // Initial credit ledger
        [
          new CreditScore(
            minerWallet.publicKey,
            this.getLatestCreditScoreFromChain(minerWallet.publicKey) + 500
          ),
        ] // Initial credit score
      );

      this.mine(genesisBlock.nonce);

      this.chain.push(genesisBlock);
      console.log("Genesis Block mined:", genesisBlock);
      return;
    }

    if (this.transferPool.length === 0) {
      console.log("No transfers in the pool to mine a block.");
      return;
    }

    const newBlock = new Block(
      this.chain.length,
      this.lastBlock.hash,
      [...this.transferPool],
      [], // Empty balances initially
      [], // Empty credit ledger initially
      [] // Empty credit scores initially
    );

    // Apply transfers
    for (const transfer of newBlock.transfers) {
      this.applyTransfer(transfer, newBlock);
      this.applyCreditRewards(transfer, newBlock); // Apply the credit earning system
    }

    // Reward miner and update credit scores
    this.rewardMiner(minerWallet, newBlock);

    newBlock.creditScores = this.consolidateCreditScores(
      newBlock.creditScores,
      newBlock.creditLedger
    );

    this.mine(newBlock.nonce);

    console.log("Block mined:", newBlock);

    // Push the mined block to the chain
    this.chain.push(newBlock);

    // Clear the transfer pool
    this.transferPool = [];
  }
}

// Wallet class
class Wallet {
  public publicKey: string;
  public privateKey: string;

  constructor() {
    const keyPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    this.publicKey = keyPair.publicKey;
    this.privateKey = keyPair.privateKey;
  }
  sendMoney(amount: number, payeePublicKey: string) {
    // Get the payer's latest balance
    const payerBalance = Chain.instance.getLatestBalanceFromChain(
      this.publicKey
    );

    // Check if the payer has sufficient funds
    if (payerBalance < amount) {
      console.log(
        `Transaction failed: Insufficient funds. ${this.publicKey} tried to send ${amount}, but only has ${payerBalance}.`
      );
      return; // Do not proceed with the transfer
    }

    // Create the transfer if sufficient funds exist
    try {
      const transfer = new Transfer(amount, this.publicKey, payeePublicKey);
      Chain.instance.addTransferToPool(transfer);
    } catch (e) {
      // Log or handle any errors in the transfer creation
      console.log(`Transaction failed: ${e}`);
    }
  }
}

// Node class representing a node in the network that mines blocks
class Node {
  public wallet: Wallet;
  private blocksMined: number = 0;

  constructor(wallet: Wallet) {
    this.wallet = wallet;
  }

  startMining() {
    setInterval(() => {
      Chain.instance.mineBlock(this.wallet);
      this.blocksMined++;
    }, 5000);
  }
}

const miner = new Wallet();

// Create a node that mines blocks, tied to the miner's wallet
const minerNode = new Node(miner);

// Start the node mining every 5 seconds
minerNode.startMining();

const bob = new Wallet();

async function mintAndPushBlock() {
  await delay(10000); // 10000 ms = 10 seconds

  // Mint 1000 tokens to the miner's public key
  Chain.instance.mintTokens(1000, miner.publicKey);

  console.log("Waiting for 10 seconds before mining...");
  await delay(10000);

  Chain.instance.mineBlock(miner);
}

// Define a helper delay function
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Execute the minting and block mining
(async () => {
  await mintAndPushBlock();

  await delay(10000);

  miner.sendMoney(10000, bob.publicKey);
  miner.sendMoney(100, miner.publicKey);
  bob.sendMoney(100, miner.publicKey);
})();
