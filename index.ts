// Proof of Credit - Creduni
// Created by Tiernan DeFranco - 2024

import * as fs from "fs";
import * as crypto from "crypto";
import * as portfinder from "portfinder";
import WebSocket, { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as os from "os";
import { ec as EC } from "elliptic";

let NODE_ADDRESS;
let NODE_PRIVATE_KEY;

const ec = new EC("secp256k1");

const WalletIDPrepend: string = "pc_";
const NATIVE_TOKEN = "CRDU";

// --- Message Types Enum ---
enum MessageType {
  CHAIN_REQUEST = "CHAIN_REQUEST",
  CHAIN = "CHAIN",
  NEW_TRANSACTION = "NEW_TRANSACTION",
  NEW_NODE = "NEW_NODE",
  NEW_NODE_LIST = "NEW_NODE_LIST",
  PROPOSED_BLOCK = "PROPOSED_BLOCK",
  VOTE = "VOTE",
  LAST_BLOCK_REQUEST = "LAST_BLOCK_REQUEST",
  LAST_BLOCK_RESPONSE = "LAST_BLOCK_RESPONSE",
}

// --- IMessage Interface ---
interface IMessage {
  id: string; // Unique identifier for the message
  type: MessageType;
  data: any;
}

class Token {
  constructor(
    public name: string,
    public ticker: string,
    public totalSupply: number,
    public decimals: number,
    public creator: string
  ) {}

  toJSON() {
    return JSON.stringify({
      name: this.name,
      ticker: this.ticker,
      totalSupply: this.totalSupply,
      decimals: this.decimals,
      creator: this.creator,
    });
  }

  static fromJSON(data: any): Token {
    const token = new Token(
      data.name,
      data.ticker,
      data.totalSupply,
      data.decimals,
      data.creator
    );
    return token;
  }
}

// --- Transaction Class ---
class Transaction {
  constructor(
    public amount: number,
    public payer: string, // Address of the sender
    public payee: string, // Address of the receiver
    public token: string,
    public fee: number = 0, // Fee added for each transaction
    public timestamp = Date.now()
  ) {
    if (amount <= 0) {
      throw new Error("Transaction amount must be positive.");
    }

    if (payer === payee) {
      throw new Error("Cannot send money to yourself.");
    }
  }

  get hash() {
    const hash = crypto
      .createHash("SHA256")
      .update(
        JSON.stringify({
          amount: this.amount,
          payer: this.payer,
          payee: this.payee,
          token: this.token,
          fee: this.fee,
          timestamp: this.timestamp,
        })
      )
      .digest("hex");
    return hash;
  }

  toJSON() {
    return {
      hash: this.hash,
      amount: this.amount,
      payer: this.payer,
      payee: this.payee,
      token: this.token,
      fee: this.fee,
      timestamp: this.timestamp,
    };
  }

  static fromJSON(data: any): Transaction {
    return new Transaction(
      data.amount,
      data.payer,
      data.payee,
      data.token,
      data.fee,
      data.timestamp
    );
  }

  toString() {
    return JSON.stringify(this);
  }
}

// --- Fee Class ---
class Fee {
  constructor(
    public amount: number,
    public recipient: string,
    public description: string
  ) {}

  toJSON() {
    return {
      amount: this.amount,
      recipient: this.recipient,
      description: this.description,
    };
  }

  static fromJSON(data: any): Fee {
    return new Fee(data.amount, data.recipient, data.description);
  }
}

// --- Credit Class (Negative amounts allowed for penalties) ---
class Credit {
  constructor(
    public amount: number,
    public receiver: string, // Address of the receiver for credits/penalties
    public reason: string // Reason for reward or penalty
  ) {}

  toJSON() {
    return {
      amount: this.amount,
      receiver: this.receiver,
      reason: this.reason,
    };
  }

  static fromJSON(data: any): Credit {
    return new Credit(data.amount, data.receiver, data.reason);
  }
}

// --- AccountBalance Class ---
class AccountBalance {
  constructor(
    public address: string,
    public balance: number = 0,
    public token: string
  ) {}

  toJSON() {
    return {
      address: this.address,
      balance: this.balance,
      token: this.token,
    };
  }

  static fromJSON(data: any): AccountBalance {
    return new AccountBalance(data.address, data.balance, data.token);
  }
}

// --- CreditScore Class ---
class CreditScore {
  constructor(public address: string, public score: number = 500) {}

  toJSON() {
    return {
      address: this.address,
      score: this.score,
    };
  }

  static fromJSON(data: any): CreditScore {
    return new CreditScore(data.address, data.score);
  }
}

// --- Block Class ---
class Block {
  constructor(
    public index: number | string,
    public prevHash: string | null,
    public transactions: Transaction[], // Transactions including fees
    public fees: Fee[],
    public accountBalances: AccountBalance[], // Account balances after consolidation
    public tokens: Token[], //New tokens added
    public creditLedger: Credit[], // Ledger for rewards and penalties
    public creditScores: CreditScore[], // Updated credit scores
    public timestamp = Date.now()
  ) {}

  get hash() {
    const str = JSON.stringify({
      index: this.index,
      prevHash: this.prevHash,
      transactions: this.transactions,
      fees: this.fees,
      accountBalances: this.accountBalances,
      tokens: this.tokens,
      creditLedger: this.creditLedger,
      creditScores: this.creditScores,
      timestamp: this.timestamp,
    });
    const hash = crypto.createHash("SHA256");
    hash.update(str).end();
    return hash.digest("hex");
  }

  toJSON() {
    return {
      index: this.index,
      hash: this.hash,
      prevHash: this.prevHash,
      transactions: this.transactions.map((tx) => tx.toJSON()),
      fees: this.fees.map((fee) => fee.toJSON()),
      accountBalances: this.accountBalances.map((balance) => balance.toJSON()),
      tokens: this.tokens.map((token) => token.toJSON()),
      creditLedger: this.creditLedger.map((credit) => credit.toJSON()),
      creditScores: this.creditScores.map((score) => score.toJSON()),
      timestamp: this.timestamp,
    };
  }

  static fromJSON(data: any): Block {
    const transactions = data.transactions.map((tx: any) =>
      Transaction.fromJSON(tx)
    );
    const fees = data.fees.map((fee: any) => Fee.fromJSON(fee));
    const accountBalances = data.accountBalances.map((ab: any) =>
      AccountBalance.fromJSON(ab)
    );
    const tokens = data.tokens.map((ab: any) => Token.fromJSON(ab));
    const creditLedger = data.creditLedger.map((c: any) => Credit.fromJSON(c));
    const creditScores = data.creditScores.map((cs: any) =>
      CreditScore.fromJSON(cs)
    );

    const block = new Block(
      data.index,
      data.prevHash,
      transactions,
      fees,
      accountBalances,
      tokens,
      creditLedger,
      creditScores,
      data.timestamp
    );

    return block;
  }
}

// --- Chain Class ---
class Chain {
  public static instance = new Chain();

  chain: Block[] = [];

  transactionPool: Transaction[] = [];

  pendingBalances: { [address: string]: { [tokenId: string]: number } } = {};

  blockchainMintAddress = "Blockchain Mint";
  blockCreditReward = 5;
  validatorCreditReward = 0.01;

  connectedNodes: Node[] = [];
  eligibleProposers: Node[] = [];

  initialMintingReward = 30;
  minimumReward = 0.00000001;

  isProposing: boolean = false;

  selectedProposer: Node | null = null;

  validatorBlock: Block | null = null;

  // Reference to the P2P Server
  p2pServer: P2PServer | null = null;

  // To keep track of processed blocks and prevent duplication
  processedBlockHashes: Set<string> = new Set();

  // --- Voting Mechanism Properties ---
  proposedBlocks: Map<
    string,
    { block: Block; votes: string[]; voters: string[] }
  > = new Map();

  constructor() {
    this.createGenesisBlock();
  }

  setP2PServer(server: P2PServer) {
    this.p2pServer = server;
  }

  isValidChain(chain: Block[]): boolean {
    if (chain.length === 0) {
      console.log("Chain is empty.");
      return false;
    }

    while (chain.length > 1) {
      const latestBlock = chain[chain.length - 1];
      const secondLastBlock = chain[chain.length - 2];

      const isLatestValid = this.isValidBlock(latestBlock, secondLastBlock);

      if (chain.length === 2 && isLatestValid) {
        const isGensisValid = this.isValidBlock(secondLastBlock, null);
        if (isGensisValid) {
          console.log("Chain is valid with 2 blocks");
          return true;
        }
        return false;
      }

      if (chain.length > 2) {
        const thirdLastBlock = chain[chain.length - 3];
        const isSecondLastValid = this.isValidBlock(
          secondLastBlock,
          thirdLastBlock
        );

        if (isLatestValid && isSecondLastValid) {
          console.log("Found adjacent valid blocks.");
          return true; // Chain is valid up to this point
        }
      }

      console.log("Removing invalid block:", latestBlock.hash);
      chain.pop(); // Remove the most recent block
    }

    // If only one block remains, ensure it's valid (likely the genesis block)
    if (chain.length === 1) {
      const genesisBlock = chain[0];
      if (genesisBlock.index === "Genesis") {
        console.log("Chain is valid with only the genesis block.");
        return true;
      } else {
        console.log("Invalid chain: Genesis block is incorrect.");
        return false;
      }
    }

    console.log("No valid sequence found.");
    return false;
  }

  replaceChain(newChain: Block[]) {
    if (this.isValidChain(newChain) && newChain.length > this.chain.length) {
      this.chain = newChain;
      console.log("Chain replaced with the new longer valid chain.");

      // Broadcast the updated chain to peers
      if (this.p2pServer) {
        this.p2pServer.broadcastChain();
      }
    } else {
      console.log("Received chain is invalid or shorter. Not replacing.");
    }
  }

  isValidBlock(newBlock: Block, previousBlock: Block | null): boolean {
    // console.log(previousBlock);
    // console.log(newBlock);
    if (previousBlock === null) {
      return this.validateGenesisBlock(newBlock);
    }

    const recalculatedHash = crypto
      .createHash("SHA256")
      .update(
        JSON.stringify({
          index: newBlock.index,
          prevHash: newBlock.prevHash,
          transactions: newBlock.transactions,
          fees: newBlock.fees,
          accountBalances: newBlock.accountBalances,
          creditLedger: newBlock.creditLedger,
          creditScores: newBlock.creditScores,
          timestamp: newBlock.timestamp,
        })
      )
      .digest("hex");

    if (newBlock.hash !== recalculatedHash) {
      console.log("Invalid block hash.");
      return false;
    }

    // Validate the previous hash
    if (previousBlock.hash !== newBlock.prevHash) {
      console.log("Invalid previous hash.");
      return false;
    }

    if (previousBlock.hash !== newBlock.prevHash) {
      console.log("Invalid previous hash.");
      return false;
    }

    if (previousBlock.index !== "Genesis") {
      if (newBlock.timestamp <= previousBlock.timestamp + this.blockTime - 10) {
        console.log(`Invalid block timestamp. Blocks too close together`);
        return false;
      }
    }

    const now = Date.now();

    if (newBlock.timestamp > now + 5000) {
      console.log(
        `Invalid block timestamp. Block timestamp (${newBlock.timestamp}) is more than 5 seconds in the future compared to current time (${now}).`
      );
      return false;
    }

    // Recalculate the hash and compare

    const proposerAddress = this.selectedProposer?.address; // Retrieve the proposer address

    const blockRewards = newBlock.creditLedger.filter(
      (credit) => credit.reason === "Block Reward"
    );

    if (blockRewards.length > 0) {
      const blockReward = blockRewards[0]; // Since we enforce only one, take the first
      if (proposerAddress) {
        if (
          blockReward.amount !== this.blockCreditReward ||
          blockReward.receiver !== proposerAddress
        ) {
          console.log(
            `Invalid block: "Block Reward" credit is incorrect. Amount: ${blockReward.amount}, Receiver: ${blockReward.receiver}, Expected Amount: ${this.blockCreditReward}, Expected Receiver: ${proposerAddress}.`
          );
          return false;
        }
      }

      if (blockRewards.length > 1) {
        console.log(
          `Invalid block: Expected 1 or 0 "Block Reward" credit, but found ${blockRewards.length}.`
        );
        return false;
      }
    }

    //make sure to also verify that the transaction hashes match, that the public key is verifed by sig, that the public key's generated address = the address

    return true;
  }

  private validateGenesisBlock(newBlock: Block): boolean {
    if (newBlock.prevHash !== null) return false;
    if (newBlock.transactions.length > 0) return false;
    if (newBlock.fees.length > 0) return false;
    if (newBlock.accountBalances.length > 0) return false;
    if (newBlock.creditLedger.length !== 1) return false;

    const isValidCredit = newBlock.creditLedger.every(
      (credit) => credit.amount <= this.blockCreditReward
    );
    if (!isValidCredit) return false;

    if (newBlock.creditScores.length !== 1) return false;

    const isValidScore = newBlock.creditScores.every(
      (creditScore) =>
        creditScore.score <=
        this.getLatestCreditScoreFromChain(creditScore.address) +
          this.blockCreditReward
    );
    if (!isValidScore) return false;

    return true;
  }

  addBlock(newBlock: Block): boolean {
    if (this.processedBlockHashes.has(newBlock.hash)) {
      console.log("Block already processed. Ignoring.");
      return false;
    }

    if (this.isValidBlock(newBlock, this.lastBlock)) {
      this.chain.push(newBlock);
      this.processedBlockHashes.add(newBlock.hash);
      console.log("Block added to the chain:", newBlock.toJSON());

      return true;
    }
    return false;
  }

  private getChainFilePath(): string {
    if (!NODE_ADDRESS!) {
      throw new Error("NODE_ADDRESS is not defined.");
    }
    const CHAINS_DIR = path.join("D:", "Chains");

    if (!fs.existsSync(CHAINS_DIR)) {
      fs.mkdirSync(CHAINS_DIR, { recursive: true });
      console.log(`Created Chains directory at ${CHAINS_DIR}`);
    }

    // Sanitize NODE_ADDRESS to prevent path traversal or invalid characters
    const sanitizedAddress = NODE_ADDRESS.replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(CHAINS_DIR, `chain_${sanitizedAddress}.txt`);
  }

  private appendBlockToFile(block: Block) {
    try {
      const filePath = this.getChainFilePath();

      // Serialize the block with indentation (2 spaces)
      const serializedBlock = JSON.stringify(block.toJSON(), null, 2);

      // Append the serialized block followed by two newlines for readability
      fs.appendFileSync(filePath, serializedBlock + "\n\n");

      console.log(`Block appended to file: ${filePath}`);
    } catch (error) {
      console.error("Failed to append block to file:", error);
    }
  }

  delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async createGenesisBlock() {
    await this.delay(2000);

    if (this.p2pServer) {
      this.p2pServer.broadcastConnectedNodes();
    }

    if (this.p2pServer && this.p2pServer.hasPeers()) {
      console.log(
        "Peers are already connected. Syncing chain instead of creating a genesis block."
      );
      this.p2pServer.requestChainFromPeers();
      return;
    }

    if (this.chain.length > 0) {
      console.log("Genesis block already exists.");
      return;
    }

    console.log("🚀 Creating the Genesis Block");

    const selectedProposer = this.selectDeterministicBlockProposer(null);
    if (!selectedProposer) {
      console.log("No eligible validator available to propose the block.");
      return;
    }

    console.log(
      `${selectedProposer.address} has been selected as the Genesis Block Proposer`
    );

    const genesisBlock = new Block(
      "Genesis",
      null,
      [], // No transactions initially
      [], // No fees
      [], // No balances
      [], // No tokens
      [], // No Credits
      [] // No Credit Scores
    );

    this.chain.push(genesisBlock);
    this.processedBlockHashes.add(genesisBlock.hash);
    console.log(
      "Genesis Block created and added by:",
      selectedProposer.address,
      genesisBlock.toJSON()
    );

    //this.appendBlockToFile(genesisBlock);

    this.proposeBlock();
  }

  addMiner(node: Node) {
    if (
      [...this.connectedNodes].some((miner) => miner.address === node.address)
    ) {
      console.log(`Miner ${node.address} is already connected.`);
      return;
    }
    this.connectedNodes.push(node);
    console.log(`Miner ${node.address} connected.`);
  }

  removeMiner(address: string) {
    const minerToRemove = [...this.connectedNodes].find(
      (miner) => miner.address === address
    );
    if (minerToRemove) {
      this.connectedNodes = this.connectedNodes.filter(
        (miner) => miner.address !== minerToRemove.address
      );

      console.log(`Miner ${address} removed.`);
    } else {
      console.log(`Miner ${address} not found.`);
    }
  }

  getMiningThreshold(): number {
    let totalScore = 0;
    let numProposers = 0;

    this.eligibleProposers.forEach((proposer) => {
      const proposerCreditScore = this.getLatestCreditScoreFromChain(
        proposer.address
      );
      totalScore += proposerCreditScore;
      numProposers++;
    });

    if (numProposers === 0) return 0;

    const averageScore = totalScore / numProposers;

    const reductionFactor = 0.25;
    const reducer = averageScore * reductionFactor;
    const reducedThreshold = averageScore - reducer;

    // Cap the threshold at 1000
    return Math.min(Math.round(reducedThreshold), 1000);
  }

  selectDeterministicBlockProposer(prevHash: string | null): Node | null {
    const threshold = this.getMiningThreshold();
    console.log("Credit Score Required:", threshold);

    this.eligibleProposers = [...this.connectedNodes]
      .filter(
        (miner) =>
          this.getLatestCreditScoreFromChain(miner.address) >= threshold
      )
      .sort((a, b) => a.address.localeCompare(b.address));

    if (this.eligibleProposers.length === 0) {
      this.eligibleProposers = [...this.connectedNodes];
    }

    console.log(this.eligibleProposers);

    const hashInput = prevHash || "defaultFallbackHash";
    const hash = crypto.createHash("SHA256").update(hashInput).digest("hex");
    const hashValue = BigInt("0x" + hash);
    const selectedIndex = Number(
      hashValue % BigInt(this.eligibleProposers.length)
    );

    return this.eligibleProposers[selectedIndex];
  }

  get lastBlock() {
    return this.chain[this.chain.length - 1];
  }

  getLatestCreditScoreFromChain(address: string): number {
    let creditScore = 500;
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      const creditScoreInBlock = block.creditScores.find(
        (cs) => cs.address === address
      );
      if (creditScoreInBlock) {
        creditScore = creditScoreInBlock.score;
        break;
      }
    }
    return creditScore;
  }

  getLatestBalanceFromChain(address: string, token: string): number {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      const accountBalance = block.accountBalances.find(
        (ab) => ab.address === address
      );
      if (accountBalance) {
        return accountBalance.balance;
      }
    }
    return 0;
  }

  getPendingBalance(address: string, token: string): number {
    // Ensure the address exists in pendingBalances
    if (!this.pendingBalances[address]) {
      this.pendingBalances[address] = {};
    }

    // Check if the token's balance is already cached in pendingBalances
    if (this.pendingBalances[address][token] !== undefined) {
      return this.pendingBalances[address][token];
    }

    // If not cached, get the latest balance from the chain
    const latestBalance = this.getLatestBalanceFromChain(address, token);
    this.pendingBalances[address][token] = latestBalance;
    return latestBalance;
  }

  updatePendingBalance(
    payer: string,
    payee: string,
    amount: number,
    token: string
  ) {
    // Subtract from payer
    if (payer !== this.blockchainMintAddress) {
      const payerBalance = this.getPendingBalance(payer, token);
      this.pendingBalances[payer][token] = payerBalance - amount;
    }

    // Add to payee
    const payeeBalance = this.getPendingBalance(payee, token);
    this.pendingBalances[payee][token] = payeeBalance + amount;
  }

  applyTransfer(transfer: Transaction, block: Block) {
    const payerBalance = this.getPendingBalance(transfer.payer, transfer.token);

    // Check if payer is the blockchain mint address (no fee applies)
    if (transfer.payer === this.blockchainMintAddress) {
      // Directly transfer the full amount to the payee without any fee
      transfer.fee = 0;

      block.transactions.push(transfer);

      // Update pending balance for the payee
      this.updatePendingBalance(
        transfer.payer,
        transfer.payee,
        transfer.amount,
        transfer.token
      );
      return;
    }

    // Proceed with regular fee calculation if payer is not blockchain mint
    if (payerBalance < transfer.amount) {
      console.log(
        `Insufficient funds: ${transfer.payer} has ${payerBalance}, tried to send ${transfer.amount}.`
      );
      return;
    }

    // Calculate the transaction fee based on the payer’s credit score
    const feePercentage = this.determineFee();

    // Calculate the fee Y
    const fee = transfer.amount * feePercentage;

    // Assign the fee to the transaction
    transfer.fee = fee;

    // Calculate the amount the payee receives (X - Y)
    const payeeAmount = transfer.amount - fee;

    // Add fee breakdown to the block
    this.addFeeBreakdownToBlock(transfer, block);

    // Add the transaction to the block
    block.transactions.push(transfer);

    // Update pending balances for the transfer
    this.updatePendingBalance(
      transfer.payer,
      transfer.payee,
      payeeAmount,
      transfer.token
    );
  }

  determineFee(): number {
    return 0.01;
  }

  addFeeBreakdownToBlock(transfer: Transaction, block: Block) {
    const { fee, token } = transfer; // Assume fee and token are part of the Transaction object

    const burnAmount = fee / 2;
    const remainingFee = fee - burnAmount;
    const proposerShare = remainingFee / 2;

    // Fee breakdown
    block.fees.push(new Fee(burnAmount, "Transaction Fee Burn", "Burned Fee"));
    if (this.selectedProposer?.address) {
      block.fees.push(
        new Fee(proposerShare, this.selectedProposer.address, "Proposer Fee")
      );
    }

    // Update pending balances for proposer and validators
    if (this.selectedProposer?.address) {
      const proposerAddress = this.selectedProposer.address;

      // Ensure pending balances structure exists for proposer and token
      if (!this.pendingBalances[proposerAddress]) {
        this.pendingBalances[proposerAddress] = {};
      }
      if (!this.pendingBalances[proposerAddress][token]) {
        this.pendingBalances[proposerAddress][token] = this.getPendingBalance(
          proposerAddress,
          token
        );
      }

      // Update proposer's pending balance
      this.pendingBalances[proposerAddress][token] += proposerShare;
    }
  } //im not sure this consolidates the fees rather than just adds them, also im not sure this is in their pending balance until the block is finalizc

  addTransferToPool(
    transaction: Transaction,
    publicKey: string,
    signature: Buffer
  ) {
    // Special case: skip signature verification for minting
    if (transaction.payer === this.blockchainMintAddress) {
      this.addPendingTransaction(transaction);
      return;
    }

    // Regular transactions: Verify signature
    const verifier = crypto.createVerify("SHA256");
    verifier.update(transaction.toString());

    const isValid = verifier.verify(publicKey, signature);

    if (isValid) {
      this.addPendingTransaction(transaction);
      console.log("Valid transaction added to the pool:", transaction);

      // Broadcast the transaction to peers
      if (this.p2pServer) {
        const message: IMessage = {
          id: uuidv4(),
          type: MessageType.NEW_TRANSACTION,
          data: transaction.toJSON(),
        };
        this.p2pServer.broadcast(message);
      }
    } else {
      console.log("Invalid signature, transaction rejected.");
    }
  }

  // Helper method to add the transaction after verification
  addPendingTransaction(transaction: Transaction) {
    const payerBalance = this.getPendingBalance(
      transaction.payer,
      transaction.token
    );

    if (
      transaction.payer !== this.blockchainMintAddress &&
      payerBalance < transaction.amount
    ) {
      console.log(
        `Transaction failed: Insufficient funds. ${transaction.payer} tried to send ${transaction.amount}, but only has ${payerBalance} available (including pending transfers).`
      );
      return;
    }

    this.transactionPool.push(transaction);
    console.log("Transaction added to the pool:", transaction);
  }

  consolidateAccountBalances(
    transactions: Transaction[],
    fees: Fee[]
  ): AccountBalance[] {
    // Use TokenData in the nested map
    const balanceMap: {
      [address: string]: {
        [tokenId: string]: { token: string; balance: number };
      };
    } = {};

    // Process transactions
    transactions.forEach((transaction) => {
      const { payer, payee, amount, token } = transaction;

      // Initialize balances for payer and payee
      if (!balanceMap[payer]) balanceMap[payer] = {};
      if (!balanceMap[payee]) balanceMap[payee] = {};
      if (!balanceMap[payer][token]) {
        balanceMap[payer][token] = {
          token,
          balance: this.getLatestBalanceFromChain(payer, token),
        };
      }
      if (!balanceMap[payee][token]) {
        balanceMap[payee][token] = {
          token,
          balance: this.getLatestBalanceFromChain(payee, token),
        };
      }

      // Update balances for the transaction
      balanceMap[payer][token].balance -= amount;
      balanceMap[payee][token].balance += amount;
    });

    // Process fees for validators
    fees.forEach((fee) => {
      if (fee.recipient !== "Transaction Fee Burn") {
        const recipient = fee.recipient;
        const token = NATIVE_TOKEN;

        if (!balanceMap[recipient]) balanceMap[recipient] = {};
        if (!balanceMap[recipient][token]) {
          balanceMap[recipient][token] = {
            token,
            balance: this.getLatestBalanceFromChain(recipient, token),
          };
        }

        // Add the converted fee to the recipient's balance
        balanceMap[recipient][token].balance += fee.amount;
      } else {
        // Handle fee burning (if applicable)
        console.log(`Burned ${fee.amount} ${NATIVE_TOKEN}`);
      }
    });

    // Flatten balanceMap into AccountBalance objects
    return Object.entries(balanceMap).flatMap(([address, tokenBalances]) =>
      Object.values(tokenBalances).map(
        ({ token, balance }) => new AccountBalance(address, balance, token)
      )
    );
  }

  applyCreditRewards(transaction: Transaction, block: Block) {
    if (transaction.payer === this.blockchainMintAddress) {
      const currentCreditScore = this.getLatestCreditScoreFromChain(
        transaction.payee
      );
      const halvedCreditScore = currentCreditScore / 2;
      block.creditLedger.push(
        new Credit(
          -halvedCreditScore,
          transaction.payee,
          "Credit Halved From Minting Tokens"
        )
      );
    }
  }

  blockTime = 20_000;
  transactionOffset = 10_000;
  proposalOffset = 1_000;
  voteOffset = 5_000;
  evalVoteOffset = 10_000;

  voteTimestamp: number | null = null;
  evalVoteTimestamp: number | null = null;

  async proposeBlock() {
    this.isProposing = true;
    console.log("Time of proposeblock start execution ", Date.now());

    const lastBlock = this.lastBlock;
    const lastBlockHash = lastBlock.hash;

    if (!this.selectedProposer) {
      this.selectedProposer =
        this.selectDeterministicBlockProposer(lastBlockHash);
    }
    if (!this.selectedProposer) {
      console.log("No eligible validator available to propose the block.");
      return;
    }

    console.log(
      `${this.selectedProposer.address} has been selected as the block proposer`
    );

    let lastBlockTransactionSignatures = new Set(
      lastBlock.transactions.map((tx) => tx.hash)
    );

    this.transactionPool = this.transactionPool.filter(
      (transaction) => !lastBlockTransactionSignatures.has(transaction.hash)
    );

    lastBlockTransactionSignatures = new Set();

    const transactionCutoffTimestamp =
      lastBlock.timestamp + this.transactionOffset;

    const blockCreationTime = lastBlock.timestamp + this.blockTime;

    const proposalTime = blockCreationTime + this.proposalOffset;

    this.voteTimestamp = proposalTime + this.voteOffset;
    this.evalVoteTimestamp = this.voteTimestamp + this.evalVoteOffset;

    console.log("Important timestamps:");
    console.log("Transaction Cutoff: ", transactionCutoffTimestamp);
    console.log("Block Creation: ", blockCreationTime);
    console.log("Block Proposal: ", proposalTime);
    console.log("Validator Voting: ", this.voteTimestamp);
    console.log("Vote Evaluation: ", this.evalVoteTimestamp);

    if (NODE_ADDRESS!) {
      const isNodeEligible = this.eligibleProposers.some(
        (node) => node.address === NODE_ADDRESS!
      );
      if (isNodeEligible) {
        const delay = blockCreationTime - Date.now();
        console.log(
          `Creating block at ${blockCreationTime}. Waiting ${delay}ms...`
        );
        await this.delay(delay > 0 ? delay : 0);

        console.log("--===Creating Block===--");
        console.log(Date.now());
        console.log(new Date().toISOString());

        const filteredTransactions = [...this.transactionPool]
          .filter(
            (transaction) => transaction.timestamp <= transactionCutoffTimestamp
          )
          .sort((a, b) => a.timestamp - b.timestamp);

        const newBlock = new Block(
          this.chain.length,
          lastBlockHash,
          [...filteredTransactions],
          [],
          [],
          [],
          [],
          []
        );

        // Apply transfers and credit rewards
        for (const transfer of this.transactionPool) {
          this.applyTransfer(transfer, newBlock);
          this.applyCreditRewards(transfer, newBlock);
        }

        this.rewardProposer(this.selectedProposer.address, newBlock);

        // Consolidate account balances and credit scores
        newBlock.accountBalances = this.consolidateAccountBalances(
          newBlock.transactions,
          newBlock.fees
        );
        newBlock.creditScores = this.consolidateCreditScores(
          newBlock.creditLedger
        );

        this.validatorBlock = newBlock;
        console.log("Validator block set at ", Date.now());

        // Broadcast the proposed block to the network
        if (this.selectedProposer.address === NODE_ADDRESS!) {
          // Broadcast the proposed block if this node is the proposer
          if (this.p2pServer) {
            const blockHash = newBlock.hash;

            const keyPair = ec.keyFromPrivate(NODE_PRIVATE_KEY!, "hex");
            const signature = keyPair.sign(blockHash);

            const proposedPublicKey = new Wallet(NODE_PRIVATE_KEY!).publicKey;

            const proposedBlockMessage: IMessage = {
              id: uuidv4(),
              type: MessageType.PROPOSED_BLOCK,
              data: {
                block: newBlock.toJSON(),
                signature,
                publicKey: proposedPublicKey,
                address: NODE_ADDRESS!,
              },
            }; //signing with private key, send public key and address, and then in handle proposed block verify the sign and then make sure the public key matches the address recieved

            this.proposedBlock = newBlock;

            const delay = proposalTime - Date.now();
            console.log(
              `Proposing block at ${proposalTime}. Waiting ${delay}ms...`
            );
            await this.delay(delay > 0 ? delay : 0);

            this.p2pServer.broadcast(proposedBlockMessage);
            console.log(
              "Proposed block broadcasted for voting",
              newBlock.hash,
              " at ",
              Date.now()
            );
            this.isProposing = false;
            this.proposedBlocks.set(newBlock.hash, {
              block: newBlock,
              votes: [],
              voters: [],
            });

            // Append the block to the chain file
            //this.appendBlockToFile(newBlock);
          }

          //this.executeSmartContractsInBlock(newBlock);
        }
      } else {
        console.log(
          "Not eligible to validate, effectively becoming readonly node"
        );
      }
    }

    let evalVoteDelay = this.evalVoteOffset;

    if (this.evalVoteTimestamp) {
      evalVoteDelay = this.evalVoteTimestamp - Date.now();
    }
    console.log(
      `Evaluating votes at  ${this.evalVoteTimestamp}: Waiting ${
        evalVoteDelay > 0 ? evalVoteDelay : 0
      }ms to evaluate votes...`
    );

    await this.delay(evalVoteDelay);
    this.evaluateVotes(this.proposedBlock?.hash!);
  }

  consolidateCreditScores(creditLedger: Credit[]): CreditScore[] {
    const scoreMap: { [key: string]: number } = {};

    creditLedger.forEach((credit) => {
      if (
        credit.receiver !== this.blockchainMintAddress &&
        !credit.receiver.startsWith("sc_")
      ) {
        if (scoreMap[credit.receiver]) {
          scoreMap[credit.receiver] += credit.amount;
        } else {
          scoreMap[credit.receiver] = credit.amount;
        }
      }
    });

    const updatedScores = Object.keys(scoreMap).map((address) => {
      const mostRecentCreditScore = this.getLatestCreditScoreFromChain(address);
      const updatedScore = mostRecentCreditScore + scoreMap[address];
      return new CreditScore(address, updatedScore);
    });

    return updatedScores.filter(
      (creditScore) =>
        creditScore.address !== this.blockchainMintAddress &&
        !creditScore.address.startsWith("sc_")
    );
  }

  rewardProposer(address: string, block: Block) {
    const validatorCredit = new Credit(
      this.blockCreditReward,
      address,
      "Block Reward"
    );
    block.creditLedger.push(validatorCredit);
  }

  getCurrentMintingReward(): number {
    const length = this.chain.length;
    const blocksPerInterval = 5_000_000; // Every 5,000,000 blocks

    const intervalsPassed = Math.floor(length / blocksPerInterval);

    // Calculate the current reward by halving the reward for each interval passed
    const currentReward = Math.max(
      this.initialMintingReward / Math.pow(2, intervalsPassed),
      this.minimumReward
    );

    return Math.floor(currentReward);
  }

  // --- Voting Mechanism Methods ---
  proposedBlock: Block | null = null;
  // Method to handle incoming proposed blocks
  async handleProposedBlock(proposedBlockData: any) {
    this.isProposing = false;
    const { block, publicKey, signature, address } = proposedBlockData;

    const proposedBlock = Block.fromJSON(block);

    if (!this.selectedProposer) {
      this.selectedProposer = this.selectDeterministicBlockProposer(
        this.lastBlock.hash
      );
    }

    this.proposedBlock = proposedBlock;

    console.log(`Received proposed block: ${proposedBlock.hash}`);

    const keyPair = ec.keyFromPublic(publicKey, "hex");
    const isValid = keyPair.verify(proposedBlock.hash, signature);

    const generatedAddress = generateAddressFromPBK(publicKey);

    if (generatedAddress !== address) {
      console.log(
        `Address included in block from ${address} and address regenerated from the public key for validation ${generatedAddress} is invalid. Ignoring block.`
      );
      return;
    }

    if (!isValid) {
      console.log(`Invalid vote signature from ${address}. Ignoring block.`);
      return;
    }

    if (generatedAddress !== this.selectedProposer?.address) {
      console.log(
        `Address included in block from ${address} and address isn't from the selected proposer. Ignoring block.`
      );
      return;
    }

    // Initialize the proposed block with no votes
    this.storeProposedBlock(proposedBlock.hash, proposedBlock);

    // If this node has a validatorBlock, vote for its own block
    if (NODE_ADDRESS! && NODE_PRIVATE_KEY! && this.validatorBlock) {
      const delay = this.voteTimestamp! - Date.now();
      console.log("Voting at ", this.voteTimestamp!, "waiting ", delay, "ms");
      await this.delay(delay > 0 ? delay : 0);

      console.log("Voting for block at", Date.now());

      const ownBlock = this.validatorBlock as Block;
      console.log("Own Hash B ", ownBlock.hash);
      ownBlock.timestamp = proposedBlock.timestamp;
      console.log("Own Hash A ", ownBlock.hash);
      const voteHash = ownBlock.hash;

      // Append the block to the chain file
      // this.appendBlockToFile(ownBlock);

      const keyPair = ec.keyFromPrivate(NODE_PRIVATE_KEY, "hex");

      const signature = keyPair.sign(voteHash);

      const votePublicKey = new Wallet(NODE_PRIVATE_KEY).publicKey;

      // Send vote with own block hash
      if (this.p2pServer) {
        const voteMessage: IMessage = {
          id: uuidv4(),
          type: MessageType.VOTE,
          data: {
            blockHash: voteHash,
            signature: signature,
            publicKey: votePublicKey,
            address: NODE_ADDRESS,
          },
        };

        this.p2pServer.broadcast(voteMessage);
        console.log(`Voted for block: ${voteHash}`);
      }

      this.storeProposedBlock(proposedBlock.hash, proposedBlock, voteHash);
    } else {
      console.log("Validator block is not available, not voting");
    }
  }

  storeProposedBlock(hash: string, block: Block, ownHash?: string) {
    if (ownHash) {
      const proposal = this.proposedBlocks.get(hash);
      if (proposal) {
        proposal.votes.push(ownHash);
        proposal.voters.push(NODE_ADDRESS!);
        console.log(`Voted for proposal for block ${hash}`);
      } else {
        this.proposedBlocks.set(hash, {
          block: block,
          votes: [ownHash],
          voters: [NODE_ADDRESS!],
        });
        console.log(`Voted on initial proposal for block ${hash}`);
      }
      return;
    }

    if (!this.proposedBlocks.has(hash)) {
      this.proposedBlocks.set(hash, {
        block: block,
        votes: [],
        voters: [],
      });
      console.log(`Initialized proposal for block ${hash}`);
    }
  }

  // Method to handle incoming votes
  async handleVote(voteData: any) {
    if (!this.proposedBlock) {
      console.log(
        `Lacking the proposed block. Requesting proposed block at ${this.evalVoteTimestamp} + 1 seconds`
      );
      let evalVoteDelay = this.evalVoteOffset;

      if (this.evalVoteTimestamp) {
        evalVoteDelay = this.evalVoteTimestamp - Date.now();
      }

      await this.delay(evalVoteDelay + 1000);
      this.selectedProposer = null;
      this.isProposing = false;

      const message: IMessage = {
        id: uuidv4(),
        type: MessageType.LAST_BLOCK_REQUEST,
        data: {},
      };
      this.p2pServer?.broadcast(message);
      return;
    }

    const { blockHash, signature, publicKey, address } = voteData;

    if (!blockHash || !signature || !publicKey || !address) {
      console.log("Malformed vote data. Ignoring vote.");
      return;
    }

    console.log(`Received vote for block hash: ${blockHash} from ${address}`);

    const keyPair = ec.keyFromPublic(publicKey, "hex");
    const isValid = keyPair.verify(blockHash, signature);

    const generatedAddress = generateAddressFromPBK(publicKey);

    if (generatedAddress !== address) {
      console.log(
        `Address included in vote from ${address} and address regenerated from the public key for validation is invalid. Ignoring vote.`
      );
      return;
    }

    if (!isValid) {
      console.log(`Invalid vote signature from ${address}. Ignoring vote.`);
      return;
    }
    // Iterate through all proposed blocks to find a match
    const proposal = this.proposedBlocks.get(blockHash);

    if (proposal) {
      if (proposal.voters.includes(address)) {
        console.log(`Duplicate vote detected from ${address}. Ignoring.`);
        return;
      }

      proposal.votes.push(blockHash); // This keeps track of the block hashes being voted on
      proposal.voters.push(address); // This ensures a node can't vote multiple times
      console.log(`Vote accepted for block hash: ${blockHash} from ${address}`);
    }
  }

  // Method to evaluate votes for a proposed block
  async evaluateVotes(proposedHash: string) {
    console.log("EVALUATING VOTES at", Date.now());

    if (!this.proposedBlock) {
      console.log(
        `Lacking the proposed block. Requesting proposed block at ${this.evalVoteTimestamp} + 1 second`
      );
      let evalVoteDelay = this.evalVoteOffset;

      if (this.evalVoteTimestamp) {
        evalVoteDelay = this.evalVoteTimestamp - Date.now();
      }

      await this.delay(evalVoteDelay + 1000);
      this.selectedProposer = null;
      this.isProposing = false;

      const message: IMessage = {
        id: uuidv4(),
        type: MessageType.LAST_BLOCK_REQUEST,
        data: {},
      };
      this.p2pServer?.broadcast(message);
      return;
    }

    const proposal = this.proposedBlocks.get(proposedHash);
    if (proposal) {
      let matchingVotesWeighted = 0;
      let totalVotesWeighted = 0;

      const proposerAddress = this.selectedProposer?.address;
      const proposerCredit = this.getLatestCreditScoreFromChain(
        proposerAddress!
      );

      const proposerVotes = calculateWeightedVotesFromCredit(proposerCredit);

      matchingVotesWeighted += proposerVotes * 0.75;
      totalVotesWeighted += proposerVotes * 0.75;

      for (let i = 0; i < proposal.voters.length; i++) {
        const voterAddress = proposal.voters[i];
        const voteHash = proposal.votes[i];
        const creditScore = this.getLatestCreditScoreFromChain(voterAddress);
        const weightedVotes = calculateWeightedVotesFromCredit(creditScore);

        if (voteHash === proposedHash) {
          matchingVotesWeighted += weightedVotes;
          console.log(
            `Voter ${voterAddress} contributed ${weightedVotes} weight to matching votes.`
          );
        }
        totalVotesWeighted += weightedVotes;
        console.log(
          `Voter ${voterAddress} contributed ${weightedVotes} weight to total votes.`
        );
      }

      const percentage = (matchingVotesWeighted / totalVotesWeighted) * 100;

      console.log(
        `Votes for block ${proposedHash}: ${matchingVotesWeighted}/${totalVotesWeighted} (${percentage.toFixed(
          2
        )}%)`
      );
      if (percentage >= 75) {
        // Add the block to the chain
        const blockAdded = this.addBlock(proposal.block);
        if (blockAdded) {
          console.log(
            "Proposed block accepted and added to the chain:",
            proposedHash
          );
        }
      } else if (percentage < 75 && percentage >= 33) {
        // Create an empty block
        const emptyBlock = new Block(
          this.chain.length,
          this.lastBlock.hash,
          [],
          [],
          [],
          [],
          [],
          [],
          proposal.block.timestamp
        );

        // Add the empty block to the chain
        const blockAdded = this.addBlock(emptyBlock);
        if (blockAdded) {
          console.log(
            `Proposed block ${proposedHash} received insufficient votes. An empty block was created.`
          );
        }
      } else if (percentage < 33 && percentage >= 15) {
        const halvedCredit =
          this.getLatestCreditScoreFromChain(this.selectedProposer?.address!) /
          2;
        // Create an empty block
        const creditHalfBlock = new Block(
          this.chain.length,
          this.lastBlock.hash,
          [],
          [],
          [],
          [],
          [
            new Credit(
              -halvedCredit,
              this.selectedProposer?.address!,
              "Proposed Malicious Block - Halved"
            ),
          ],
          [],
          proposal.block.timestamp
        );

        creditHalfBlock.creditScores = this.consolidateCreditScores(
          creditHalfBlock.creditLedger
        );

        // Add the empty block to the chain
        const blockAdded = this.addBlock(creditHalfBlock);
        if (blockAdded) {
          console.log(
            `Proposed block ${proposedHash} was in superminority, proposer's score was halved`
          );
        }
      } else if (percentage < 15) {
        const credit = this.getLatestCreditScoreFromChain(
          this.selectedProposer?.address!
        );
        // Create an empty block
        const noCreditBlock = new Block(
          this.chain.length,
          this.lastBlock.hash,
          [],
          [],
          [],
          [],
          [
            new Credit(
              -credit,
              this.selectedProposer?.address!,
              "Proposed Malicious Block - Zeroed Out"
            ),
          ],
          [],
          proposal.block.timestamp
        );

        noCreditBlock.creditScores = this.consolidateCreditScores(
          noCreditBlock.creditLedger
        );

        // Add the empty block to the chain
        const blockAdded = this.addBlock(noCreditBlock);
        if (blockAdded) {
          console.log(
            `Proposed block ${proposedHash} was in SUPER SUPER minority, proposer's score was set to 0`
          );
        }
      } else {
        console.log(
          `Unhandled case for block ${proposedHash} with vote percentage ${percentage}.`
        );
      }

      // Remove the proposal from the map
      this.proposedBlocks.delete(proposedHash);

      this.selectedProposer = null;
      this.validatorBlock = null;
      this.voteTimestamp = null;
      this.evalVoteTimestamp = null;

      this.proposeBlock();
    }
  }
}

interface CreditVoteMapping {
  credit: number;
  votes: number;
}

const creditVoteMappings: CreditVoteMapping[] = [
  { credit: 0, votes: 0.1 },
  { credit: 250, votes: 0.5 },
  { credit: 500, votes: 1 },
  { credit: 750, votes: 1.5 },
  { credit: 1_000, votes: 5 },
  { credit: 2_500, votes: 8 },
  { credit: 5_000, votes: 10 },
  { credit: 10_000, votes: 15 },
  { credit: 25_000, votes: 20 },
  { credit: 50_000, votes: 35 },
  { credit: 100_000, votes: 50 },
];

function calculateWeightedVotesFromCredit(creditScore: number): number {
  // Handle credit scores below the minimum mapping
  if (creditScore <= creditVoteMappings[0].credit) {
    return creditVoteMappings[0].votes;
  }

  // Handle credit scores above the maximum mapping
  if (creditScore >= creditVoteMappings[creditVoteMappings.length - 1].credit) {
    return creditVoteMappings[creditVoteMappings.length - 1].votes;
  }

  // Iterate through the mappings to find the correct interval
  for (let i = 0; i < creditVoteMappings.length - 1; i++) {
    const current = creditVoteMappings[i];
    const next = creditVoteMappings[i + 1];

    if (creditScore === current.credit) {
      return current.votes;
    }

    if (creditScore > current.credit && creditScore < next.credit) {
      // Calculate the slope (rate of change)
      const slope =
        (next.votes - current.votes) / (next.credit - current.credit);
      // Perform linear interpolation
      const interpolatedVotes =
        current.votes + slope * (creditScore - current.credit);
      // Cap the vote weight at 100 and round to the nearest tenth
      const cappedVoteWeight = Math.min(interpolatedVotes, 100);
      const roundedVoteWeight = Math.round(cappedVoteWeight * 10) / 10;
      return roundedVoteWeight;
    }
  }

  // Fallback in case the creditScore doesn't match any condition
  return 1;
}

function generateAddressFromPBK(publicKey: string): string {
  const keyPair = ec.keyFromPublic(publicKey, "hex");

  const hashedPublicKey = crypto
    .createHash("sha256")
    .update(keyPair.getPublic(true, "hex"), "hex")
    .digest("hex");
  return (
    WalletIDPrepend + hashedPublicKey.slice(0, 30 - WalletIDPrepend.length)
  );
}

// --- Wallet Class ---
class Wallet {
  public publicKey: string;
  public privateKey: string;
  public address: string;

  constructor(privateKeyInput?: string) {
    let privateKeyHex: string;

    if (privateKeyInput) {
      // Check if the input is a hex private key
      if (/^[0-9a-fA-F]{64}$/.test(privateKeyInput)) {
        privateKeyHex = privateKeyInput;
      } else {
        // Assume it's a file path and try to read the key
        try {
          privateKeyHex = fs.readFileSync(privateKeyInput, "utf8").trim();
        } catch (error) {
          throw new Error("Failed to read private key from file: " + error);
        }
      }
    } else {
      // Generate a new secp256k1 key pair
      const keyPair = ec.genKeyPair();
      privateKeyHex = keyPair.getPrivate("hex");
    }

    NODE_PRIVATE_KEY = privateKeyHex;

    // Initialize the elliptic key pair using the private key
    const keyPair = ec.keyFromPrivate(privateKeyHex, "hex");

    this.privateKey = privateKeyHex; // Hex-encoded private key
    this.publicKey = keyPair.getPublic(true, "hex"); // Compressed public key

    // Compute the wallet address based on the hashed public key
    this.address = generateAddressFromPBK(this.publicKey);
  }

  public sendMoney(amount: number, payeeAddress: string, token: string) {
    const payerBalance = Chain.instance.getPendingBalance(this.address, token);

    if (payerBalance < amount) {
      console.log(
        `Transaction failed: Insufficient funds. ${this.address} tried to send ${amount} of ${token}, but only has ${payerBalance}.`
      );
      return;
    }

    try {
      const transaction = new Transaction(
        amount,
        this.address,
        payeeAddress,
        token
      );
      const sign = crypto.createSign("SHA256");
      sign.update(transaction.toString()).end();
      const signature = sign.sign(this.privateKey);

      Chain.instance.addTransferToPool(transaction, this.publicKey, signature);
      console.log(
        `Transaction created: ${this.address} -> ${payeeAddress} : ${amount}`
      );
    } catch (e) {
      console.error(`Transaction failed: ${e}`);
    }
  }

  mintTokens() {
    const reward = Chain.instance.getCurrentMintingReward();

    const mintTransfer = new Transaction(
      reward,
      Chain.instance.blockchainMintAddress,
      this.address,
      NATIVE_TOKEN
    );
    Chain.instance.addTransferToPool(mintTransfer, "", Buffer.alloc(0));

    console.log(`Minted ${reward} tokens for ${this.address}`);
  }
}

// --- Node Class ---
class Node {
  constructor(public address: string) {
    Chain.instance.addMiner(this);
  }
}

// --- P2P Server Class ---
class P2PServer {
  private wss: WebSocketServer;
  private sockets: WebSocket[] = [];
  private port: number;
  private peers: string[];
  private processedMessageIds: Set<string> = new Set();

  constructor(port: number, peers: string[] = []) {
    this.port = port;
    this.peers = peers;
    this.wss = new WebSocketServer({ port: this.port });
    this.listen();
    this.connectToPeers(this.peers);
    console.log(`WebSocket P2P server listening on port: ${this.port}`);

    // Periodic cleanup of processedMessageIds to prevent memory leaks
    this.cleanupProcessedMessages();
  }

  public static async create(
    basePort: number = 3170,
    peers: string[] = []
  ): Promise<P2PServer> {
    portfinder.setBasePort(basePort);

    try {
      const availablePort = await portfinder.getPortPromise();
      const server = new P2PServer(availablePort, peers);
      return server;
    } catch (error) {
      throw new Error(
        `Failed to find an available port starting from ${basePort}: ${error}`
      );
    }
  }

  public getPort(): number {
    return this.port;
  }

  private listen() {
    this.wss.on("connection", (socket) => {
      console.log("New peer connected");
      this.initConnection(socket);
    });
  }

  private connectToPeers(peers: string[]) {
    peers.forEach((peer) => {
      const socket = new WebSocket(peer);
      socket.on("open", () => {
        console.log(`Connected to peer: ${peer}`);
        this.initConnection(socket);
      });
      socket.on("error", (err) => {
        console.log(`Connection failed to peer ${peer}: ${err.message}`);
      });
    });
  }

  private initConnection(socket: WebSocket) {
    this.sockets.push(socket);
    this.setupMessageHandler(socket);
    this.setupErrorHandler(socket);

    // Send this node's wallet address to the new peer
    const walletAddress = this.getNodeWalletAddress();
    if (walletAddress) {
      const newNodeMessage: IMessage = {
        id: uuidv4(),
        type: MessageType.NEW_NODE,
        data: { address: walletAddress },
      };
      socket.send(JSON.stringify(newNodeMessage));

      console.log(
        `Connection initialized with peer. Sent wallet address: ${walletAddress}`
      );
    }

    this.sendChain(socket);
    this.sendConnectedNodes(socket);
  }

  private setupMessageHandler(socket: WebSocket) {
    socket.on("message", (data: WebSocket.Data) => {
      try {
        const message: IMessage = JSON.parse(data.toString());
        this.handleMessage(message, socket);
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    });
  }

  private setupErrorHandler(socket: WebSocket) {
    const closeConnection = () => {
      console.log("Peer disconnected");
      this.sockets = this.sockets.filter((s) => s !== socket);
    };

    socket.on("close", closeConnection);
    socket.on("error", closeConnection);
  }

  private handleMessage(message: IMessage, socket: WebSocket) {
    if (this.processedMessageIds.has(message.id)) {
      return;
    }

    // Mark the message as processed
    this.processedMessageIds.add(message.id);

    switch (message.type) {
      case MessageType.CHAIN_REQUEST:
        this.sendChain(socket);
        break;
      case MessageType.CHAIN:
        this.handleChainResponse(message.data);
        break;
      case MessageType.NEW_TRANSACTION:
        this.handleNewTransaction(message.data, socket);
        break;
      case MessageType.NEW_NODE:
        this.handleNewNode(message.data, socket);
        break;
      case MessageType.NEW_NODE_LIST:
        this.handleNewNodeList(message);
        break;
      case MessageType.PROPOSED_BLOCK:
        Chain.instance.handleProposedBlock(message.data);
        break;
      case MessageType.VOTE:
        Chain.instance.handleVote(message.data);
        break;
      case MessageType.LAST_BLOCK_REQUEST:
        this.handleBlockRequest(socket);
        break;
      case MessageType.LAST_BLOCK_RESPONSE:
        this.handleBlockResponse(message.data);
        break;
      default:
        console.log("Unknown message type:", message.type);
    }

    // Forward the message to other peers except the sender
    this.broadcast(message, socket);
  }

  private handleBlockRequest(socket: WebSocket) {
    if (!NODE_PRIVATE_KEY! || !NODE_ADDRESS!) return;

    const latestBlock = Chain.instance.lastBlock;
    const latestBlockHash = latestBlock.hash;

    const keyPair = ec.keyFromPrivate(NODE_PRIVATE_KEY!, "hex");
    const signature = keyPair.sign(latestBlockHash);

    const proposedPublicKey = new Wallet(NODE_PRIVATE_KEY!).publicKey;
    const message: IMessage = {
      id: uuidv4(),
      type: MessageType.LAST_BLOCK_RESPONSE,
      data: {
        block: latestBlock.toJSON(),
        signature,
        publicKey: proposedPublicKey,
        address: NODE_ADDRESS,
      },
    };
    console.log("sending latest block", latestBlockHash);
    socket.send(JSON.stringify(message));
  }

  private blockResponseCounts: {
    [hash: string]: { block: Block; count: number };
  } = {};

  private blockResponseTimeout: NodeJS.Timeout | null = null;

  private handleBlockResponse(data: any) {
    const { block, signature, publicKey, address } = data;

    const receivedBlock = Block.fromJSON(block);

    const recievedBlockHash = receivedBlock.hash;

    const keyPair = ec.keyFromPublic(publicKey, "hex");
    const isValid = keyPair.verify(recievedBlockHash, signature);

    const generatedAddress = generateAddressFromPBK(publicKey);

    if (generatedAddress !== address) {
      console.log(
        `Address included in block from ${address} and address regenerated from the public key for validation is invalid. Ignoring block.`
      );
      return;
    }

    if (!isValid) {
      console.log(`Invalid signature from ${address}. Ignoring block.`);
      return;
    }

    if (!receivedBlock || !recievedBlockHash) {
      console.log("Received invalid block data. Ignoring.");
      return;
    }

    console.log("recieved block:", recievedBlockHash);
    console.log("block pre vhash", receivedBlock.prevHash);

    if (this.blockResponseCounts[recievedBlockHash]) {
      this.blockResponseCounts[recievedBlockHash].count += 1;
    } else {
      this.blockResponseCounts[recievedBlockHash] = {
        block: receivedBlock,
        count: 1,
      };
    }

    if (!this.blockResponseTimeout) {
      this.blockResponseTimeout = setTimeout(() => {
        this.processCollectedBlockResponses();
      }, 2000); // Wait for 2 seconds to collect blocks
    }
  }

  private processCollectedBlockResponses() {
    // Clear the timeout
    if (this.blockResponseTimeout) {
      clearTimeout(this.blockResponseTimeout);
      this.blockResponseTimeout = null;
    }

    // Determine the block with the highest count
    let candidateBlocks: { hash: string; block: Block }[] = [];

    let maxCount = 0;
    for (const [hash, { block, count }] of Object.entries(
      this.blockResponseCounts
    )) {
      if (count > maxCount) {
        maxCount = count;
        candidateBlocks = [{ hash, block }];
        maxCount = count;
      } else if (count === maxCount) {
        candidateBlocks.push({ hash, block });
      }
    }

    if (candidateBlocks.length === 0) {
      console.log("No blocks received from peers. Cannot proceed.");
      this.blockResponseCounts = {};
      return;
    }

    candidateBlocks.sort((a, b) => a.hash.localeCompare(b.hash));
    const selectedBlock = candidateBlocks[0].block;

    // Validate the selected block
    if (Chain.instance.isValidBlock(selectedBlock, Chain.instance.lastBlock)) {
      Chain.instance.chain.push(selectedBlock);
      Chain.instance.processedBlockHashes.add(selectedBlock.hash);
      console.log(`Received and added missing block: ${selectedBlock}`);

      // Proceed with proposing the next block or other necessary actions
      Chain.instance.proposeBlock();
    } else {
      console.log(`Invalid block received: ${selectedBlock.hash}. Ignoring.`);
    }

    // Clear the collected blocks
    this.blockResponseCounts = {};
  }

  private handleNewTransaction(transactionData: any, senderSocket: WebSocket) {
    const transaction = Transaction.fromJSON(transactionData);
    Chain.instance.addPendingTransaction(transaction);
    console.log("New transaction added from network:", transaction);
  }

  private handleNewNode(
    nodeData: { address: string },
    senderSocket: WebSocket
  ) {
    const existingNode = Chain.instance.connectedNodes.find(
      (node) => node.address === nodeData.address
    );
    if (!existingNode) {
      new Node(nodeData.address); // Add the new node to the chain
      console.log(`New node added to the network: ${nodeData.address}`);
    }
    this.broadcastConnectedNodes(senderSocket);
  }

  private handleNewNodeList(message: IMessage) {
    const nodeList: string[] = message.data.nodes || [];

    Chain.instance.eligibleProposers = message.data.proposers || [];

    nodeList.forEach((address) => {
      const existingNode = Chain.instance.connectedNodes.find(
        (node) => node.address === address
      );
      if (!existingNode) {
        new Node(address);
        console.log(`Node added from node list: ${address}`);
      }
    });
    console.log(
      "Synchronized connected nodes:",
      Chain.instance.connectedNodes.sort((a, b) =>
        a.address.localeCompare(b.address)
      )
    );

    if (!Chain.instance.selectedProposer) {
      Chain.instance.selectedProposer = message.data.selectedProposer;
      console.log("Selected Proposer: ", message.data.selectedProposer);
    }
  }

  private getNodeWalletAddress(): string {
    return NODE_ADDRESS!;
  }

  private async handleChainResponse(chainData: any[]) {
    const receivedChain = chainData.map((blockData) =>
      Block.fromJSON(blockData)
    );
    if (
      receivedChain.length > Chain.instance.chain.length &&
      Chain.instance.isValidChain(receivedChain)
    ) {
      Chain.instance.replaceChain(receivedChain);
      console.log("Received chain is valid. Replacing the current chain.");
      // Broadcast the updated chain to other peers
      this.broadcastChain();

      await Chain.instance.delay(1000);

      if (!Chain.instance.isProposing) {
        console.log(
          "The selected proposer before proposing is:",
          Chain.instance.selectedProposer
        );
        Chain.instance.proposeBlock();
      }
    } else {
      console.log("Received chain is invalid or shorter. Ignoring.");
    }
  }

  private sendChain(socket: WebSocket) {
    const message: IMessage = {
      id: uuidv4(),
      type: MessageType.CHAIN,
      data: Chain.instance.chain.map((block) => block.toJSON()),
    };
    socket.send(JSON.stringify(message));
  }

  public broadcast(message: IMessage, excludeSocket?: WebSocket) {
    this.sockets.forEach((socket) => {
      if (socket !== excludeSocket) {
        socket.send(JSON.stringify(message));
      }
    });
  }

  public broadcastChain() {
    const message: IMessage = {
      id: uuidv4(),
      type: MessageType.CHAIN,
      data: Chain.instance.chain.map((block) => block.toJSON()),
    };
    this.broadcast(message);
  }

  hasPeers(): boolean {
    return this.sockets.length > 0;
  }

  requestChainFromPeers() {
    const message: IMessage = {
      id: uuidv4(),
      type: MessageType.CHAIN_REQUEST,
      data: null,
    };
    this.broadcast(message);
  }

  public broadcastConnectedNodes(excludeSocket?: WebSocket) {
    const connectedNodes = [...Chain.instance.connectedNodes]
      .map((node) => node.address)
      .sort((a, b) => a.localeCompare(b));
    const message: IMessage = {
      id: uuidv4(),
      type: MessageType.NEW_NODE_LIST,
      data: {
        nodes: connectedNodes || [],
        proposers: Chain.instance.eligibleProposers || [],
        selectedProposer: Chain.instance.selectedProposer!,
      },
    };
    this.broadcast(message, excludeSocket);
  }

  private sendConnectedNodes(socket: WebSocket) {
    const connectedNodes = [...Chain.instance.connectedNodes]
      .map((node) => node.address)
      .sort((a, b) => a.localeCompare(b));
    const message: IMessage = {
      id: uuidv4(),
      type: MessageType.NEW_NODE_LIST,
      data: {
        nodes: connectedNodes || [],
        proposers: Chain.instance.eligibleProposers || [],
        selectedProposer: Chain.instance.selectedProposer!,
      },
    };
    socket.send(JSON.stringify(message));
  }

  private cleanupProcessedMessages() {
    setInterval(() => {
      this.processedMessageIds.clear();
      console.log("Cleaned up processed message IDs.");
    }, 60 * 60 * 1000); // Every hour
  }
}

function createWallet() {
  console.log("creating wallet");

  const wallet = new Wallet();

  // Define the directory path in the user's Documents folder
  const dirPath = path.join(os.homedir(), "Documents", "Credunity");
  const filePath = path.join(
    dirPath,
    `privateKey-${Math.round(Math.random() * 10000)}.dat`
  );

  // Ensure the directory exists
  fs.mkdirSync(dirPath, { recursive: true });

  fs.writeFileSync(filePath, wallet.privateKey);

  console.log(`New wallet created and saved to '${filePath}'`);
}

// --- Chain Initialization and P2P Server Setup ---
const args = process.argv.slice(2);
console.log(args);

if (args.length === 0 || (args.includes("--createWallet") && args.length > 1)) {
  console.error(
    "Usage: node index.js [--createWallet] | [--privateKey <private_key_file>] [--port <port>] [--peers <peer1,peer2>]"
  );
  process.exit(1);
}

const createWalletIndex = args.indexOf("--createWallet");
const privateKeyIndex = args.indexOf("--privateKey");
const peersArgIndex = args.indexOf("--peers");

if (createWalletIndex !== -1) {
  createWallet();
  process.exit(0);
}

const peers =
  peersArgIndex !== -1 && args[peersArgIndex + 1]
    ? args[peersArgIndex + 1].split(",").map((peer) => peer.trim())
    : [];

if (privateKeyIndex !== -1 && args[privateKeyIndex + 1]) {
  const privateKey = args[privateKeyIndex + 1];
  const wallet = new Wallet(privateKey);
  NODE_ADDRESS = wallet.address;
  // Initialize as a full node
  new Node(NODE_ADDRESS);
} else {
  // Initialize as a read-only node
  console.log("Starting in read-only mode. No private key provided.");
}

// Initialize the P2P Server
(async () => {
  try {
    const basePort = 3170;
    console.log(basePort);
    const p2pServer = await P2PServer.create(basePort, peers);
    Chain.instance.setP2PServer(p2pServer);
    console.log(
      `P2P Server successfully started on port ${p2pServer.getPort()}`
    );
  } catch (error) {
    console.error("Failed to start P2P Server:", error);
    process.exit(1);
  }
})();
