// blockchain.ts
import fs from "fs";
import * as crypto from "crypto";
import portfinder from "portfinder";
import WebSocket, { Server as WebSocketServer } from "ws";
import net from "net";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import os from "os";

let NODE_ADDRESS;
let NODE_PRIVATE_KEY;

const WalletIDPrepend: string = "pc_";

// --- Message Types Enum ---
enum MessageType {
  CHAIN_REQUEST = "CHAIN_REQUEST",
  CHAIN = "CHAIN",
  NEW_TRANSACTION = "NEW_TRANSACTION",
  NEW_CONTRACT = "NEW_CONTRACT",
  NEW_NODE = "NEW_NODE",
  NEW_NODE_LIST = "NEW_NODE_LIST",
  PROPOSED_BLOCK = "PROPOSED_BLOCK", // Added for proposed blocks
  VOTE = "VOTE", // Added for voting
}

// --- IMessage Interface ---
interface IMessage {
  id: string; // Unique identifier for the message
  type: MessageType;
  data: any;
}

// --- Transaction Class ---
class Transaction {
  constructor(
    public amount: number,
    public payer: string, // Address of the sender
    public payee: string, // Address of the receiver
    public metadata: { [key: string]: any } | null = null, // Optional metadata for additional data like contract args
    public fee: number = 0 // Fee added for each transaction
  ) {
    if (amount <= 0) {
      throw new Error("Transaction amount must be positive.");
    }

    if (payer === payee) {
      throw new Error("Cannot send money to yourself.");
    }
  }

  toJSON() {
    return {
      amount: this.amount,
      payer: this.payer,
      payee: this.payee,
      metadata: this.metadata ? JSON.stringify(this.metadata) : null,
      fee: this.fee,
    };
  }

  static fromJSON(data: any): Transaction {
    return new Transaction(
      data.amount,
      data.payer,
      data.payee,
      data.metadata ? JSON.parse(data.metadata) : null,
      data.fee
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
  constructor(public address: string, public balance: number = 0) {}

  toJSON() {
    return {
      address: this.address,
      balance: this.balance,
    };
  }

  static fromJSON(data: any): AccountBalance {
    return new AccountBalance(data.address, data.balance);
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

// --- SmartContract Class ---
class SmartContract {
  public code: string; // Raw TypeScript code for the contract
  public address: string | null = null; // Contract's address, to be determined later
  public publisherAddress: string | null = null; // Address of the creator

  constructor(code: string) {
    this.code = code;
  }

  setPublisherAddress(address: string) {
    if (this.publisherAddress == null) {
      this.publisherAddress = address;
    }
  }

  generateAddress(prevBlockHash: string) {
    if (this.publisherAddress === null) {
      throw new Error("Publisher address is not set.");
    }

    const hash = crypto
      .createHash("SHA256")
      .update(this.code + this.publisherAddress + prevBlockHash)
      .digest("hex");

    this.address = "sc_" + hash.slice(0, 30); // Adjust the slice length as needed
  }

  // Executes the contract after it is included in a block
  execute(
    args: any[],
    callerAddress: string,
    hash: string
  ): { result: any; transactions: Transaction[] } {
    if (this.address === null) {
      throw new Error(
        "Contract address is null. Ensure generateAddress has been called before execute."
      );
    }

    const temporaryTransactions: Transaction[] = [];

    const state = Chain.instance.getLatestContractState(this.address!);

    const initialState = { ...state };

    try {
      const vm = require("vm");

      // Wrap the contract code in a function expression
      const wrappedCode = `(function(args, caller, state, console, hash, chain, sendMoney) { 
        ${this.code}
      })(args, caller, state, console, hash, chain, sendMoney);`;

      // Create a sandbox environment for the contract
      const sandbox = {
        args,
        caller: callerAddress,
        state,
        console,
        hash,
        selfAddress: this.address,
        chain: {
          getCreditScore: (address: string) => {
            return Chain.instance.getLatestCreditScoreFromChain(address);
          },
          getConfirmedBalance: (address: string) => {
            return Chain.instance.getLatestBalanceFromChain(address);
          },
          getPendingBalance: (address: string) => {
            return Chain.instance.getPendingBalance(address);
          },
        },
        sendMoney: (amount: number, payeeAddress: string) => {
          const transaction = new Transaction(
            amount,
            this.address!,
            payeeAddress
          );
          temporaryTransactions.push(transaction);
        },
      };

      const context = vm.createContext(sandbox);

      // Create the script from the wrapped code
      const script = new vm.Script(wrappedCode);

      // Run the contract code in a sandbox
      const result = script.runInContext(context, { timeout: 5000 }); // Timeout in milliseconds

      const stateChanged = !this.isStateEqual(initialState, state);

      // If state has changed and is not empty, add it to the statePool
      if (stateChanged && Object.keys(state).length > 0) {
        const contractState = new ContractState(this.address!, { ...state });
        Chain.instance.statePool.push(contractState);
      }

      // Return the temporary transactions along with the result
      return { result, transactions: temporaryTransactions };
    } catch (e: any) {
      console.error("Error executing smart contract:", e);
      // In case of error, discard the temporary transactions
      return { result: null, transactions: [] };
    }
  }

  private isStateEqual(
    state1: { [key: string]: any },
    state2: { [key: string]: any }
  ): boolean {
    const keys1 = Object.keys(state1);
    const keys2 = Object.keys(state2);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
      if (state1[key] !== state2[key]) {
        return false;
      }
    }

    return true;
  }

  toJSON() {
    return {
      address: this.address,
      publisherAddress: this.publisherAddress,
      code: this.code,
    };
  }

  static fromJSON(data: any): SmartContract {
    const contract = new SmartContract(data.code);
    contract.address = data.address;
    contract.publisherAddress = data.publisherAddress;
    return contract;
  }
}

// --- ContractState Class ---
class ContractState {
  address: string;
  state: { [key: string]: any };

  constructor(address: string, initialState: { [key: string]: any } = {}) {
    this.address = address;
    this.state = { ...initialState };
  }

  toJSON() {
    return {
      address: this.address,
      state: JSON.stringify(this.state),
    };
  }

  static fromJSON(data: any): ContractState {
    return new ContractState(
      data.address,
      data.state ? JSON.parse(data.state) : {}
    );
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
    public creditLedger: Credit[], // Ledger for rewards and penalties
    public creditScores: CreditScore[], // Updated credit scores
    public contracts: SmartContract[],
    public contractStates: ContractState[],
    public timestamp = Date.now()
  ) {}

  get hash() {
    const str = JSON.stringify(this);
    const hash = crypto.createHash("SHA256");
    hash.update(str).end();
    return hash.digest("hex");
  }

  toJSON() {
    return {
      index: this.index,
      prevHash: this.prevHash,
      transactions: this.transactions.map((tx) => tx.toJSON()),
      fees: this.fees.map((fee) => fee.toJSON()),
      accountBalances: this.accountBalances.map((balance) => balance.toJSON()),
      creditLedger: this.creditLedger.map((credit) => credit.toJSON()),
      creditScores: this.creditScores.map((score) => score.toJSON()),
      contracts: this.contracts.map((contract) => contract.toJSON()),
      contractStates: this.contractStates.map((state) => state.toJSON()),
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
    const creditLedger = data.creditLedger.map((c: any) => Credit.fromJSON(c));
    const creditScores = data.creditScores.map((cs: any) =>
      CreditScore.fromJSON(cs)
    );
    const contracts = data.contracts.map((c: any) => SmartContract.fromJSON(c));
    const contractStates = data.contractStates.map((cs: any) =>
      ContractState.fromJSON(cs)
    );

    const block = new Block(
      data.index,
      data.prevHash,
      transactions,
      fees,
      accountBalances,
      creditLedger,
      creditScores,
      contracts,
      contractStates,
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
  contractPool: SmartContract[] = [];
  statePool: ContractState[] = [];

  pendingBalances: { [key: string]: number } = {};

  blockchainMintAddress = "Blockchain Mint";
  blockCreditReward = 25;

  connectedNodes: Node[] = [];
  eligibleValidators: Node[] = [];

  initialMintingReward = 100;
  minimumReward = 1;

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

  executeSmartContract(
    contractAddress: string,
    value: number, // The amount of tokens to transfer to the contract
    args: any[], // Arguments for the smart contract
    caller: string
  ): any {
    const length = this.chain.length;

    if (length === 0) {
      console.log(`Chain is empty`);
      return null;
    }

    // Get the caller's balance before executing the contract
    const callerBalance = this.getPendingBalance(caller);

    // Check if the caller has sufficient balance to cover the value
    if (callerBalance < value) {
      console.log(
        `Insufficient balance. Caller has ${callerBalance} but tried to send ${value}.`
      );
      return null;
    }

    // Transfer value from the caller to the contract
    if (value > 0) {
      const contractExecution = new Transaction(
        value,
        caller,
        contractAddress,
        { args }
      );
      this.transactionPool.push(contractExecution);
      console.log(
        `Transferred ${value} tokens from ${caller} to contract ${contractAddress} with args ${JSON.stringify(
          args
        )}`
      );

      // Broadcast the transaction to peers
      if (this.p2pServer) {
        const message: IMessage = {
          id: uuidv4(),
          type: MessageType.NEW_TRANSACTION,
          data: contractExecution.toJSON(),
        };
        this.p2pServer.broadcast(message);
      }
    }
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
          contracts: newBlock.contracts,
          contractStates: newBlock.contractStates,
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

    const invalidNetworkParticipation = newBlock.creditLedger.find(
      (credit) =>
        credit.reason === "Network Participation" && credit.amount > 10
    );
    if (invalidNetworkParticipation) {
      console.log(
        `Invalid credit in creditLedger. Network Participation credits (${invalidNetworkParticipation.amount}) exceed the allowed limit of 10.`
      );
      return false;
    }

    for (const transaction of newBlock.transactions) {
      const { payer, payee, amount, fee } = transaction;

      // Check if the payer is the blockchain mint address
      if (payer === this.blockchainMintAddress) {
        const currentReward = this.getCurrentMintingReward();
        if (amount > currentReward) {
          console.log(
            "Tried to mint",
            amount,
            " tokens while the current minting reward is ",
            currentReward
          );
          return false;
        }
        // Find credit deductions for the payee in the credit ledger
        const payeeCredits = newBlock.creditLedger.filter(
          (credit) => credit.receiver === payee
        );

        const totalDeduction = payeeCredits.reduce(
          (sum, credit) => sum + credit.amount,
          0
        );

        if (totalDeduction === 0) {
          console.log(
            `No corresponding credit deduction for payee ${payee} in creditLedger, but should've halved their tokens to mint.`
          );
          return false;
        }

        // Find the credit score for the payee
        const payeeCreditScore = newBlock.creditScores.find(
          (creditScore) => creditScore.address === payee
        );

        if (!payeeCreditScore) {
          console.log(`No credit score found for payee ${payee}.`);
          return false;
        }

        // Ensure credit score aligns within the 100-credit window
        if (Math.abs(totalDeduction - payeeCreditScore.score) > 100) {
          console.log(
            `Credit score (${payeeCreditScore.score}) is not within 100 credits of the credit deduction (${totalDeduction}) for ${payee}.`
          );
          return false;
        }
      } else {
        if (transaction.fee == 0) return false;
        const expectedFeePercentage = this.determineFee(payer);
        const expectedFee = amount * expectedFeePercentage;
        if (fee !== expectedFee) {
          console.log(
            `Invalid transaction fee for transaction from ${payer} to ${payee}. Expected: ${expectedFee}, Actual: ${fee}.`
          );
          return false;
        }
      }
    }

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

    if (newBlock.contracts.length > 0 || newBlock.contractStates.length > 0)
      return false;

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
      console.log("Block added to the chain:", newBlock);

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
      [
        new Credit(
          this.blockCreditReward,
          selectedProposer.address,
          "Block Reward"
        ),
      ], // Credit rewards for Genesis block
      [
        new CreditScore(
          selectedProposer.address,
          this.blockCreditReward +
            this.getLatestCreditScoreFromChain(selectedProposer.address)
        ),
      ], // Updated credit score
      [], // No contracts
      [] // No state
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
    let numValidators = 0;

    this.eligibleValidators.forEach((validator) => {
      const validatorCreditScore = this.getLatestCreditScoreFromChain(
        validator.address
      );
      totalScore += validatorCreditScore;
      numValidators++;
    });

    if (numValidators === 0) return 0;

    const averageScore = totalScore / numValidators;

    const reductionFactor = 0.3;
    const reducer = averageScore * reductionFactor;
    const reducedThreshold = averageScore - reducer;

    // Cap the threshold at 1000
    return Math.min(Math.round(reducedThreshold), 1000);
  }

  selectDeterministicBlockProposer(prevHash: string | null): Node | null {
    const threshold = this.getMiningThreshold();
    console.log("Credit Score Required:", threshold);

    this.eligibleValidators = [...this.connectedNodes]
      .filter(
        (miner) =>
          this.getLatestCreditScoreFromChain(miner.address) >= threshold
      )
      .sort((a, b) => a.address.localeCompare(b.address));

    console.log(this.eligibleValidators);

    if (this.eligibleValidators.length === 0) {
      console.log("No eligible validators found.");
      return null;
    }

    const hashInput = prevHash || "defaultFallbackHash";
    const hash = crypto.createHash("SHA256").update(hashInput).digest("hex");
    const hashValue = BigInt("0x" + hash);
    const selectedIndex = Number(
      hashValue % BigInt(this.eligibleValidators.length)
    );

    return this.eligibleValidators[selectedIndex];
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

  getLatestBalanceFromChain(address: string): number {
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

  getLatestContractState(contractAddress: string): { [key: string]: any } {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      for (const contractState of block.contractStates) {
        if (contractState.address === contractAddress) {
          return { ...contractState.state }; // Return the latest snapshot of the contract's state
        }
      }
    }
    return {}; // Return empty if no state found
  }

  getPendingBalance(address: string): number {
    // Check if the address has an in-memory balance
    if (this.pendingBalances[address] !== undefined) {
      return this.pendingBalances[address];
    }

    // If not in memory, get the latest balance from the chain
    const latestBalance = this.getLatestBalanceFromChain(address);
    this.pendingBalances[address] = latestBalance;
    return latestBalance;
  }

  updatePendingBalance(payer: string, payee: string, amount: number) {
    // Subtract from payer
    if (payer !== this.blockchainMintAddress) {
      const payerBalance = this.getPendingBalance(payer);
      this.pendingBalances[payer] = payerBalance - amount;
    }

    // Add to payee
    const payeeBalance = this.getPendingBalance(payee);
    this.pendingBalances[payee] = payeeBalance + amount;
  }

  applyTransfer(transfer: Transaction, block: Block) {
    const payerBalance = this.getPendingBalance(transfer.payer);

    // Check if payer is the blockchain mint address (no fee applies)
    if (transfer.payer === this.blockchainMintAddress) {
      // Directly transfer the full amount to the payee without any fee
      transfer.fee = 0;

      block.transactions.push(transfer);

      // Update pending balance for the payee
      this.updatePendingBalance(
        transfer.payer,
        transfer.payee,
        transfer.amount
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
    const feePercentage = this.determineFee(transfer.payer);

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
    this.updatePendingBalance(transfer.payer, transfer.payee, payeeAmount);
  }

  determineFee(payerAddress: string): number {
    const creditScore = this.getLatestCreditScoreFromChain(payerAddress);
    let feePercentage = 0.015; // Default 1.5%

    if (creditScore >= 5000) feePercentage = 0.002; // 0.2%
    else if (creditScore >= 1000) feePercentage = 0.005; // 0.5%
    else if (creditScore >= 750) feePercentage = 0.01; // 1%
    else if (creditScore >= 500) feePercentage = 0.015; // 1.5%
    else if (creditScore >= 300) feePercentage = 0.05; // 5%
    else if (creditScore >= 200) feePercentage = 0.15; // 15%
    else if (creditScore >= 100) feePercentage = 0.25; // 25%
    else if (creditScore >= 50) feePercentage = 0.5; // 50%
    else if (creditScore === 0) feePercentage = 0.99; // 99%

    return feePercentage;
  }

  addFeeBreakdownToBlock(transfer: Transaction, block: Block) {
    const fee = transfer.fee;
    const burnAmount = fee / 2;
    const remainingFee = fee - burnAmount;
    const proposerShare = remainingFee / 2;

    // Get validator addresses excluding the proposer
    const validatorAddresses = [...this.eligibleValidators]
      .filter((miner) => miner.address !== this.selectedProposer?.address) // Exclude the proposer
      .map((miner) => miner.address); // Extract addresses

    const validatorShare =
      validatorAddresses.length > 0
        ? remainingFee / 2 / validatorAddresses.length
        : 0;

    // Fee breakdown
    block.fees.push(new Fee(burnAmount, "Transaction Fee Burn", "Burned Fee"));
    if (this.selectedProposer?.address) {
      block.fees.push(
        new Fee(proposerShare, this.selectedProposer.address, "Proposer Fee")
      );
    }

    for (const validator of validatorAddresses) {
      block.fees.push(new Fee(validatorShare, validator, "Validator Fee"));
    }

    // Update pending balances for proposer and validators
    if (this.selectedProposer?.address) {
      this.pendingBalances[this.selectedProposer.address] =
        (this.pendingBalances[this.selectedProposer.address] || 0) +
        proposerShare;
    }

    for (const validator of validatorAddresses) {
      this.pendingBalances[validator] =
        (this.pendingBalances[validator] || 0) + validatorShare;
    }
  }

  addTransferToPool(
    transaction: Transaction,
    publicKey: string,
    signature: Buffer
  ) {
    // Reject any transaction with payer address starting with "sc_"
    if (transaction.payer.startsWith("sc_")) {
      console.log(
        "Invalid transaction: Transactions from smart contract addresses cannot be added externally."
      );
      return;
    }

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
    const payerBalance = this.getPendingBalance(transaction.payer);

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

  addSmartContractToPool(contract: SmartContract, author: string) {
    contract.generateAddress(this.lastBlock.hash);
    this.contractPool.push(contract);
    console.log("Smart contract added to the pool:", contract);

    // Broadcast the new contract to peers
    if (this.p2pServer) {
      const message: IMessage = {
        id: uuidv4(),
        type: MessageType.NEW_CONTRACT,
        data: contract.toJSON(),
      };
      this.p2pServer.broadcast(message);
    }
  }

  consolidateAccountBalances(
    transactions: Transaction[],
    fees: Fee[]
  ): AccountBalance[] {
    const balanceMap: { [key: string]: number } = {};

    transactions.forEach((transaction) => {
      if (transaction.payer !== this.blockchainMintAddress) {
        if (balanceMap[transaction.payer] === undefined) {
          balanceMap[transaction.payer] = this.getLatestBalanceFromChain(
            transaction.payer
          );
        }
        balanceMap[transaction.payer] -= transaction.amount;
      }

      if (transaction.payee !== this.blockchainMintAddress) {
        if (balanceMap[transaction.payee] === undefined) {
          balanceMap[transaction.payee] = this.getLatestBalanceFromChain(
            transaction.payee
          );
        }
        balanceMap[transaction.payee] += transaction.amount - transaction.fee;
      }
    });

    // Also, adjust balances for fees (excluding burned fees)
    fees.forEach((fee) => {
      if (fee.recipient !== "Transaction Fee Burn") {
        if (balanceMap[fee.recipient] === undefined) {
          balanceMap[fee.recipient] = this.getLatestBalanceFromChain(
            fee.recipient
          );
        }
        balanceMap[fee.recipient] += fee.amount;
      }
    });

    return Object.keys(balanceMap).map(
      (address) => new AccountBalance(address, balanceMap[address])
    );
  }

  applyCreditRewards(transaction: Transaction, block: Block) {
    if (
      transaction.payer !== this.blockchainMintAddress &&
      !transaction.payee.startsWith("sc_") &&
      !transaction.payer.startsWith("sc_")
    ) {
      const payerInLast1Block = this.wasPayerInLastBlocks(transaction.payer, 1);
      const payerInLast2Blocks = this.wasPayerInLastBlocks(
        transaction.payer,
        2
      );

      if (payerInLast2Blocks) {
        block.creditLedger.push(
          new Credit(
            -50,
            transaction.payer,
            "Penalty for frequent transactions"
          )
        );
      } else if (!payerInLast1Block) {
        block.creditLedger.push(
          new Credit(10, transaction.payer, "Network Participation")
        );
        block.creditLedger.push(
          new Credit(10, transaction.payee, "Network Participation")
        );
      }
    } else if (transaction.payer === this.blockchainMintAddress) {
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
  proposalOffset = 1_000;
  voteOffset = 5_000;
  evalVoteOffset = 10_000;

  voteTimestamp: number | null = null;
  evalVoteTimestamp: number | null = null;

  async proposeBlock() {
    console.log("Time of proposeblock start execution ", Date.now());
    this.selectedProposer = null;
    this.validatorBlock = null;
    this.voteTimestamp = null;
    this.evalVoteTimestamp = null;

    const lastBlock = this.lastBlock;
    const lastBlockHash = lastBlock.hash;

    this.selectedProposer =
      this.selectDeterministicBlockProposer(lastBlockHash);
    if (!this.selectedProposer) {
      console.log("No eligible validator available to propose the block.");
      return;
    }

    console.log(
      `${this.selectedProposer.address} has been selected as the block proposer`
    );

    const blockCreationTime = lastBlock.timestamp + this.blockTime;

    const proposalTime = blockCreationTime + this.proposalOffset;

    this.voteTimestamp = proposalTime + this.voteOffset;
    this.evalVoteTimestamp = this.voteTimestamp + this.evalVoteOffset;

    console.log("Important timestamps:");
    console.log("Block Creation: ", blockCreationTime);
    console.log("Block Proposal: ", proposalTime);
    console.log("Validator Voting: ", this.voteTimestamp);
    console.log("Vote Evaluation: ", this.evalVoteTimestamp);

    if (NODE_ADDRESS!) {
      const isNodeEligible = this.eligibleValidators.some(
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

        const newBlock = new Block(
          this.chain.length,
          lastBlockHash,
          [...this.transactionPool],
          [],
          [],
          [],
          [],
          [...this.contractPool],
          [...this.statePool]
        );

        // Apply transfers and credit rewards
        for (const transfer of this.transactionPool) {
          this.applyTransfer(transfer, newBlock);
          this.applyCreditRewards(transfer, newBlock);
        }

        this.rewardValidator(this.selectedProposer.address, newBlock);

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

            const sign = crypto.createSign("SHA256");
            sign.update(blockHash);
            sign.end();
            const signature = sign.sign(NODE_PRIVATE_KEY!, "hex");

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
            }; //add signing with private key, send public key and address, and then in handle proposed block verify the sign and then make sure the public key matches the address recieved

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

            this.proposedBlocks.set(newBlock.hash, {
              block: newBlock,
              votes: [],
              voters: [],
            });

            // Append the block to the chain file
            //this.appendBlockToFile(newBlock);

            const evalVoteDelay = this.evalVoteTimestamp! - Date.now();
            console.log(
              `Evalulating votes at ${this.evalVoteTimestamp}. Waiting ${evalVoteDelay}ms...`
            );
            await this.delay(evalVoteDelay);
            this.evaluateVotes(newBlock.hash);
          }

          this.executeSmartContractsInBlock(newBlock);
        }
      } else {
        console.log(
          "Not eligible to validate, effectively becoming readonly node"
        );
      }
    }
  }

  executeSmartContractsInBlock(block: Block) {
    // Iterate over a copy of the transactions array because it may be modified
    const transactionsToProcess = [...this.transactionPool];

    for (const transaction of transactionsToProcess) {
      if (transaction.payee.startsWith("sc_")) {
        const contractAddress = transaction.payee;
        let contract: SmartContract | undefined;

        // Search for the contract in the block's contracts
        contract = block.contracts.find((c) => c.address === contractAddress);

        if (!contract) {
          // If not found in the current block, search in the chain
          contract = this.findContractInChain(contractAddress);
        }

        if (contract) {
          // Extract arguments from the transaction metadata, if available
          const args = transaction.metadata?.args || [];

          // Execute the smart contract with the extracted arguments and the payer as the caller
          try {
            const { result, transactions: contractTransactions } =
              contract.execute(args, transaction.payer, block.hash);

            // Process the transactions generated by the contract
            for (const contractTx of contractTransactions) {
              // Ensure the contract has sufficient balance to send the money
              const contractBalance = this.getPendingBalance(contractTx.payer);
              if (contractBalance < contractTx.amount) {
                continue;
              }

              // Add to block's transactions
              this.transactionPool.push(contractTx);

              // Broadcast the new contract transaction to peers
              if (this.p2pServer) {
                const message: IMessage = {
                  id: uuidv4(),
                  type: MessageType.NEW_TRANSACTION,
                  data: contractTx.toJSON(),
                };
                this.p2pServer.broadcast(message);
              }
            }
          } catch (e) {
            console.error(`Error executing contract ${contract.address}:`, e);
          }
        }
      }
    }
  }

  // Helper method to find a contract in the chain
  findContractInChain(contractAddress: string): SmartContract | undefined {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      const block = this.chain[i];
      const contract = block.contracts.find(
        (c) => c.address === contractAddress
      );
      if (contract) {
        return contract;
      }
    }
    return undefined;
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

  rewardValidator(validatorAddress: string, block: Block) {
    const validatorCredit = new Credit(
      this.blockCreditReward,
      validatorAddress,
      "Block Reward"
    );
    block.creditLedger.push(validatorCredit);
  }

  wasPayerInLastBlocks(address: string, blocksToCheck: number): boolean {
    const chainLength = this.chain.length;
    for (
      let i = chainLength - 1;
      i >= Math.max(0, chainLength - blocksToCheck);
      i--
    ) {
      const block = this.chain[i];
      if (block.transactions.some((t) => t.payer === address)) {
        return true;
      }
    }
    return false;
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

  // Method to handle incoming proposed blocks
  async handleProposedBlock(proposedBlockData: any) {
    const { block, publicKey, signature, address } = proposedBlockData;

    const proposedBlock = Block.fromJSON(block);

    console.log(`Received proposed block: ${proposedBlock.hash}`);

    const verify = crypto.createVerify("SHA256");
    verify.update(proposedBlock.hash);
    verify.end();
    const isValid = verify.verify(publicKey, signature, "hex");

    const hashedPublicKey = crypto
      .createHash("sha256")
      .update(publicKey)
      .digest("hex");
    const generatedAddress =
      WalletIDPrepend + hashedPublicKey.slice(0, 30 - WalletIDPrepend.length);

    if (generatedAddress !== address) {
      console.log(
        `Address included in block from ${address} and address regenerated from the public key for validation is invalid. Ignoring block.`
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

      const sign = crypto.createSign("SHA256");
      sign.update(voteHash).end();
      const voteSignature = sign.sign(NODE_PRIVATE_KEY!, "hex");

      const votePublicKey = new Wallet(NODE_PRIVATE_KEY).publicKey;

      // Send vote with own block hash
      if (this.p2pServer) {
        const voteMessage: IMessage = {
          id: uuidv4(),
          type: MessageType.VOTE,
          data: {
            blockHash: voteHash,
            signature: voteSignature,
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
    this.evaluateVotes(proposedBlock.hash);
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
  handleVote(voteData: any) {
    const { blockHash, signature, publicKey, address } = voteData;

    if (!blockHash || !signature || !publicKey || !address) {
      console.log("Malformed vote data. Ignoring vote.");
      return;
    }

    console.log(`Received vote for block hash: ${blockHash} from ${address}`);

    const verify = crypto.createVerify("SHA256");
    verify.update(blockHash);
    verify.end();
    const isValid = verify.verify(publicKey, signature, "hex");

    const hashedPublicKey = crypto
      .createHash("sha256")
      .update(publicKey)
      .digest("hex");
    const generatedAddress =
      WalletIDPrepend + hashedPublicKey.slice(0, 30 - WalletIDPrepend.length);

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

    if (!proposal) {
      console.log(`No proposal found for block hash: ${blockHash}`);
      const filePath = path.join("D:/Chains", `${this.chain.length}.txt`);
      const blockData = JSON.stringify(proposal, null, 2);

      try {
        fs.writeFileSync(filePath, blockData);
        console.log(`Block data written to file: ${filePath}`);
      } catch (error) {
        console.error(`Failed to write block data to file: ${error}`);
      }
      return;
    }

    if (proposal.voters.includes(address)) {
      console.log(`Duplicate vote detected from ${address}. Ignoring.`);
      return;
    }

    proposal.votes.push(blockHash); // This keeps track of the block hashes being voted on
    proposal.voters.push(address); // This ensures a node can't vote multiple times
    console.log(`Vote accepted for block hash: ${blockHash} from ${address}`);
  }

  // Method to evaluate votes for a proposed block
  async evaluateVotes(proposedHash: string) {
    console.log("EVALUATING VOTES at", Date.now());
    const proposal = this.proposedBlocks.get(proposedHash);
    if (!proposal) {
      console.log(`No proposal found for hash: ${proposedHash}`);
      return;
    }

    const totalVotes = proposal.votes.length + 1;
    if (totalVotes == 1 || totalVotes == 2) {
      const blockIndex = proposal.block.index;
      const filePath = path.join(
        "D:/Chains",
        `${blockIndex}-votes-${totalVotes}.txt`
      );
      const blockData = JSON.stringify(proposal.block.toJSON(), null, 2);

      try {
        fs.writeFileSync(filePath, blockData);
        console.log(`Block data written to file: ${filePath}`);
      } catch (error) {
        console.error(`Failed to write block data to file: ${error}`);
      }
    }
    const matchingVotes =
      proposal.votes.filter((voteHash) => voteHash === proposedHash).length + 1;

    const percentage = (matchingVotes / totalVotes) * 100;

    console.log(
      `Votes for block ${proposedHash}: ${matchingVotes}/${totalVotes} (${percentage.toFixed(
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
        this.getLatestCreditScoreFromChain(this.selectedProposer?.address!) / 2;
      // Create an empty block
      const creditHalfBlock = new Block(
        this.chain.length,
        this.lastBlock.hash,
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
        [],
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
        [
          new Credit(
            -credit,
            this.selectedProposer?.address!,
            "Proposed Malicious Block - Zeroed Out"
          ),
        ],
        [],
        [],
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

    this.proposeBlock();
  }
}

// --- Wallet Class ---
class Wallet {
  public publicKey: string;
  public privateKey: string;
  public address: string;

  constructor(privateKeyInput?: string) {
    let privateKeyPEM;

    if (privateKeyInput) {
      // Check if the input looks like a PEM file (direct private key string)
      if (privateKeyInput.includes("-----BEGIN PRIVATE KEY-----")) {
        privateKeyPEM = privateKeyInput;
        NODE_PRIVATE_KEY = privateKeyInput;
      } else {
        // Assume it's a file path and try to read the PEM file
        try {
          privateKeyPEM = fs.readFileSync(privateKeyInput, "utf8");
          NODE_PRIVATE_KEY = privateKeyPEM;
        } catch (error) {
          throw new Error("Failed to read private key from file: " + error);
        }
      }

      // Construct the private key from the PEM string
      const keyObject = crypto.createPrivateKey({
        key: privateKeyPEM,
        format: "pem",
        type: "pkcs8",
      });

      // Set the private key and generate the public key from it
      this.privateKey = privateKeyPEM;
      this.publicKey = crypto
        .createPublicKey(keyObject)
        .export({ type: "spki", format: "pem" })
        .toString(); // Ensure it's a string
    } else {
      // Generate a new key pair if no private key input is provided
      const keyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      this.publicKey = keyPair.publicKey;
      this.privateKey = keyPair.privateKey;
    }

    // Compute the wallet address based on the hashed public key
    const hashedPublicKey = crypto
      .createHash("sha256")
      .update(this.publicKey)
      .digest("hex");
    this.address =
      WalletIDPrepend + hashedPublicKey.slice(0, 30 - WalletIDPrepend.length);
  }

  sendMoney(amount: number, payeeAddress: string) {
    const payerBalance = Chain.instance.getPendingBalance(this.address);

    if (payerBalance < amount) {
      console.log(
        `Transaction failed: Insufficient funds. ${this.address} tried to send ${amount}, but only has ${payerBalance}.`
      );
      return;
    }

    try {
      const transaction = new Transaction(amount, this.address, payeeAddress);
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
      this.address
    );
    Chain.instance.addTransferToPool(mintTransfer, "", Buffer.alloc(0));

    console.log(`Minted ${reward} tokens for ${this.address}`);
  }

  executeSmartContract(contractAddress: string, value: number, args: any[]) {
    return Chain.instance.executeSmartContract(
      contractAddress,
      value,
      args,
      this.address
    );
  }

  publishSmartContract(contract: SmartContract) {
    contract.setPublisherAddress(this.address);
    Chain.instance.addSmartContractToPool(contract, this.address);
    console.log(`Smart contract published by ${this.address}`);
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
    portfinder.basePort = basePort; // Set the base port

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
      case MessageType.NEW_CONTRACT:
        this.handleNewContract(message.data, socket);
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
      default:
        console.log("Unknown message type:", message.type);
    }

    // Forward the message to other peers except the sender
    this.broadcast(message, socket);
  }

  private handleNewTransaction(transactionData: any, senderSocket: WebSocket) {
    const transaction = Transaction.fromJSON(transactionData);
    Chain.instance.addPendingTransaction(transaction);
    console.log("New transaction added from network:", transaction);
    // Broadcast handled by broadcast in handleMessage
  }

  private handleNewContract(contractData: any, senderSocket: WebSocket) {
    const contract = SmartContract.fromJSON(contractData);
    Chain.instance.addSmartContractToPool(contract, contract.publisherAddress!);
    console.log("New smart contract added from network:", contract);
    // Broadcast handled by broadcast in handleMessage
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

    Chain.instance.eligibleValidators = message.data.validators || [];

    if (!Chain.instance.selectedProposer) {
      Chain.instance.selectedProposer = message.data.selectedProposer;
      console.log("Selected Proposer: ", message.data.selectedProposer);
    }

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
  }

  private getNodeWalletAddress(): string {
    return NODE_ADDRESS!;
  }

  private handleChainResponse(chainData: any[]) {
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
        validators: Chain.instance.eligibleValidators || [],
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
        validators: Chain.instance.eligibleValidators || [],
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
  const wallet = new Wallet();

  // Define the directory path in the user's Documents folder
  const dirPath = path.join(os.homedir(), "Documents", "ProofOfCredit");
  const filePath = path.join(dirPath, "privateKey2.dat");

  // Ensure the directory exists
  fs.mkdirSync(dirPath, { recursive: true });

  fs.writeFileSync(filePath, wallet.privateKey);

  console.log(`New wallet created and saved to '${filePath}'`);
}

// --- Chain Initialization and P2P Server Setup ---
const args = process.argv.slice(2);

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
