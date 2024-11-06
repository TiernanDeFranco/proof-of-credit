"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = __importStar(require("crypto"));
// Transfer class with validation for positive amount and preventing self-transfers
class Transaction {
    constructor(amount, payer, // Address of the sender
    payee, // Address of the receiver
    metadata = null // Optional metadata for additional data like contract args
    ) {
        this.amount = amount;
        this.payer = payer;
        this.payee = payee;
        this.metadata = metadata;
        if (amount <= 0) {
            throw new Error("Transaction amount must be positive.");
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
    constructor(amount, receiver, // Address of the receiver for credits/penalties
    reason // Reason for reward or penalty
    ) {
        this.amount = amount;
        this.receiver = receiver;
        this.reason = reason;
    }
    toString() {
        return JSON.stringify(this);
    }
}
// AccountBalance class that holds balance for each account
class AccountBalance {
    constructor(address, balance = 0) {
        this.address = address;
        this.balance = balance;
    }
    increase(amount) {
        this.balance += amount;
    }
    decrease(amount) {
        if (this.balance >= amount) {
            this.balance -= amount;
        }
    }
}
// CreditScore class to hold credit score for each account
class CreditScore {
    constructor(address, score = 500) {
        this.address = address;
        this.score = score;
    }
    increase(amount) {
        this.score += amount;
    }
    decrease(amount) {
        this.score -= amount;
    }
}
class SmartContract {
    constructor(code) {
        this.address = null; // Contract's address, to be determined later
        this.publisherAddress = null; // Address of the creator
        this.code = code;
    }
    setPublisherAddress(address) {
        if (this.publisherAddress == null) {
            this.publisherAddress = address;
        }
    }
    generateAddress(prevBlockHash) {
        if (this.publisherAddress === null) {
            throw new Error("Publisher address is not set.");
        }
        const hash = crypto
            .createHash("sha256")
            .update(this.code + this.publisherAddress + prevBlockHash)
            .digest("hex");
        this.address = "sc_" + hash.slice(0, 30); // Adjust the slice length as needed
    }
    // Executes the contract after it is included in a block
    execute(args, callerAddress, hash) {
        if (this.address === null) {
            throw new Error("Contract address is null. Ensure generateAddress has been called before execute.");
        }
        const temporaryTransactions = [];
        try {
            const vm = require("vm");
            // Wrap the contract code in a function expression
            const wrappedCode = `(function(args, caller, hash, chain, sendMoney) { 
        ${this.code}
      })(args, caller, hash, chain, sendMoney);`;
            // Create a sandbox environment for the contract
            const sandbox = {
                args,
                caller: callerAddress,
                hash,
                selfAddress: this.address,
                chain: {
                    getCreditScore: (address) => {
                        return Chain.instance.getLatestCreditScoreFromChain(address);
                    },
                    getConfirmedBalance: (address) => {
                        return Chain.instance.getLatestBalanceFromChain(address);
                    },
                    getPendingBalance: (address) => {
                        return Chain.instance.getPendingBalance(address);
                    },
                },
                sendMoney: (amount, payeeAddress) => {
                    const transaction = new Transaction(amount, this.address, payeeAddress);
                    temporaryTransactions.push(transaction);
                },
            };
            const context = vm.createContext(sandbox);
            // Create the script from the wrapped code
            const script = new vm.Script(wrappedCode);
            // Run the contract code in a sandbox
            const result = script.runInContext(context, { timeout: 5000 }); // Timeout in milliseconds
            // Return the temporary transactions along with the result
            return { result, transactions: temporaryTransactions };
        }
        catch (e) {
            console.error("Error executing smart contract:", e);
            // In case of error, discard the temporary transactions
            return { result: null, transactions: [] };
        }
    }
}
// Block class with both Transfer and Credit functionality
class Block {
    constructor(index, prevHash, transactions, // Separate array for transfers
    accountBalances, // List of updated account balances
    creditLedger, // Separate array for rewards and penalties
    creditScores, // List of updated credit scores
    contracts, timestamp = Date.now()) {
        this.index = index;
        this.prevHash = prevHash;
        this.transactions = transactions;
        this.accountBalances = accountBalances;
        this.creditLedger = creditLedger;
        this.creditScores = creditScores;
        this.contracts = contracts;
        this.timestamp = timestamp;
    }
    get hash() {
        const str = JSON.stringify(this);
        const hash = crypto.createHash("SHA256");
        hash.update(str).end();
        return hash.digest("hex");
    }
}
class Chain {
    constructor() {
        this.chain = [];
        this.transactionPool = [];
        this.contractPool = [];
        this.pendingBalances = {};
        this.blockchainMintAddress = "Blockchain Mint";
        this.blockCreditReward = 10;
        this.connectedMiners = new Set();
        this.blockTime = 15000;
        this.initialMintingReward = 100;
        this.minimumReward = 1;
        this.createGenesisBlock();
    }
    executeSmartContract(contractAddress, value, // The amount of tokens to transfer to the contract
    args, // Arguments for the smart contract
    caller) {
        const length = this.chain.length;
        if (length === 0) {
            console.log(`Chain is empty`);
            return null;
        }
        // Get the caller's balance before executing the contract
        const callerBalance = this.getPendingBalance(caller);
        // Check if the caller has sufficient balance to cover the value
        if (callerBalance < value) {
            console.log(`Insufficient balance. Caller has ${callerBalance} but tried to send ${value}.`);
            return null;
        }
        // Transfer value from the caller to the contract
        if (value > 0) {
            const contractExecution = new Transaction(value, caller, contractAddress, { args });
            this.transactionPool.push(contractExecution);
            console.log(`Transferred ${value} tokens from ${caller} to contract ${contractAddress} with args ${{
                args,
            }}`);
        }
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    async createGenesisBlock() {
        if (this.chain.length === 0) {
            console.log("🚀 Creating the Genesis Block...");
            await this.delay(5000);
            const selectedValidator = this.selectDeterministicValidator(null);
            if (!selectedValidator) {
                console.log("No eligible validator available to propose the block.");
                return;
            }
            console.log(selectedValidator, " has been selected as the Genesis Block Proposer");
            const genesisBlock = new Block("Genesis", null, [], // No transfers initially
            [], // No account balances
            [
                new Credit(this.blockCreditReward, selectedValidator, "Genesis Block Reward"),
            ], // Credit rewards for Genesis block
            [
                new CreditScore(selectedValidator, this.blockCreditReward +
                    this.getLatestCreditScoreFromChain(selectedValidator)),
            ], // Updated credit score
            []);
            this.chain.push(genesisBlock);
            console.log("Genesis Block created and added by:", selectedValidator, genesisBlock);
            this.proposeBlock();
        }
    }
    addMiner(minerAddress) {
        this.connectedMiners.add(minerAddress);
    }
    removeMiner(minerAddress) {
        this.connectedMiners.delete(minerAddress);
    }
    getMiningThreshold() {
        let totalScore = 0;
        let numMiners = 0;
        this.connectedMiners.forEach((minerAddress) => {
            const minerCreditScore = this.getLatestCreditScoreFromChain(minerAddress);
            totalScore += minerCreditScore;
            numMiners++;
        });
        if (numMiners === 0)
            return 0;
        // Calculate average score
        const averageScore = totalScore / numMiners;
        // Calculate threshold based on average score
        const threshold = averageScore - averageScore / 10;
        // Ensure the threshold doesn't exceed 1000
        return Math.min(Math.round(threshold), 1000);
    }
    selectDeterministicValidator(prevHash) {
        const threshold = this.getMiningThreshold();
        console.log("Credit Score Required: ", Math.round(threshold));
        const eligibleMiners = Array.from(this.connectedMiners).filter((minerAddress) => this.getLatestCreditScoreFromChain(minerAddress) >= threshold);
        if (eligibleMiners.length === 0) {
            console.log("No eligible miners for block creation.");
            return null;
        }
        // If no previous hash exists, use a fallback value
        const hashInput = prevHash || "defaultFallbackHash";
        // Use a cryptographic hash function to get a secure number
        const hash = crypto.createHash("sha256").update(hashInput).digest("hex");
        // Convert the hash hex string to an integer
        const hashValue = BigInt("0x" + hash);
        console.log(hashValue);
        // Use the hash value to deterministically select a validator
        const selectedIndex = Number(hashValue % BigInt(eligibleMiners.length));
        return eligibleMiners[selectedIndex];
    }
    get lastBlock() {
        return this.chain[this.chain.length - 1];
    }
    getLatestCreditScoreFromChain(address) {
        let creditScore = 500;
        for (let i = this.chain.length - 1; i >= 0; i--) {
            const block = this.chain[i];
            const creditScoreInBlock = block.creditScores.find((cs) => cs.address === address);
            if (creditScoreInBlock) {
                creditScore = creditScoreInBlock.score;
                break;
            }
        }
        return creditScore;
    }
    getLatestBalanceFromChain(address) {
        for (let i = this.chain.length - 1; i >= 0; i--) {
            const block = this.chain[i];
            const accountBalance = block.accountBalances.find((ab) => ab.address === address);
            if (accountBalance) {
                return accountBalance.balance;
            }
        }
        return 0;
    }
    getPendingBalance(address) {
        // Check if the address has an in-memory balance
        if (this.pendingBalances[address] !== undefined) {
            return this.pendingBalances[address];
        }
        // If not in memory, get the latest balance from the chain
        const latestBalance = this.getLatestBalanceFromChain(address);
        this.pendingBalances[address] = latestBalance;
        return latestBalance;
    }
    updatePendingBalance(payer, payee, amount) {
        // Subtract from payer
        if (payer !== this.blockchainMintAddress) {
            const payerBalance = this.getPendingBalance(payer);
            this.pendingBalances[payer] = payerBalance - amount;
        }
        // Add to payee
        const payeeBalance = this.getPendingBalance(payee);
        this.pendingBalances[payee] = payeeBalance + amount;
    }
    applyTransfer(transfer, block) {
        const payerBalance = this.getPendingBalance(transfer.payer);
        const payeeBalance = this.getPendingBalance(transfer.payee);
        if (payerBalance < transfer.amount &&
            transfer.payer !== this.blockchainMintAddress) {
            console.log(`Insufficient funds: ${transfer.payer} has ${payerBalance}, tried to send ${transfer.amount}.`);
            return;
        }
        if (transfer.payer !== this.blockchainMintAddress) {
            const newPayerBalance = payerBalance - transfer.amount;
            const payerAccount = new AccountBalance(transfer.payer, newPayerBalance);
            block.accountBalances.push(payerAccount);
        }
        const newPayeeBalance = payeeBalance + transfer.amount;
        const payeeAccount = new AccountBalance(transfer.payee, newPayeeBalance);
        block.accountBalances.push(payeeAccount);
        this.updatePendingBalance(transfer.payer, transfer.payee, transfer.amount);
    }
    addTransferToPool(transaction, publicKey, signature) {
        // Reject any transaction with payer address starting with "sc_"
        if (transaction.payer.startsWith("sc_")) {
            console.log("Invalid transaction: Transactions from smart contract addresses cannot be added externally.");
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
        }
        else {
            console.log("Invalid signature, transaction rejected.");
        }
    }
    // Helper method to add the transaction after verification
    addPendingTransaction(transaction) {
        var _a, _b;
        const payerBalance = this.getPendingBalance(transaction.payer);
        const payeeBalance = this.getPendingBalance(transaction.payee);
        if (transaction.payer !== this.blockchainMintAddress &&
            payerBalance < transaction.amount) {
            console.log(`Transaction failed: Insufficient funds. ${transaction.payer} tried to send ${transaction.amount}, but only has ${payerBalance} available (including pending transfers).`);
            return;
        }
        this.pendingBalances[transaction.payer] =
            ((_a = this.pendingBalances[transaction.payer]) !== null && _a !== void 0 ? _a : payerBalance) -
                transaction.amount;
        this.pendingBalances[transaction.payee] =
            ((_b = this.pendingBalances[transaction.payee]) !== null && _b !== void 0 ? _b : payeeBalance) +
                transaction.amount;
        this.transactionPool.push(transaction);
        console.log(`Transfer added to pool: ${transaction.amount} from ${transaction.payer} to ${transaction.payee}`);
    }
    addSmartContractToPool(contract, author) {
        contract.generateAddress(this.lastBlock.hash);
        this.contractPool.push(contract);
        console.log(`Smart contract ${contract.address} added by ${author}`);
    }
    consolidateAccountBalances(transaction) {
        const balanceMap = {};
        transaction.forEach((transaction) => {
            if (transaction.payer !== this.blockchainMintAddress) {
                if (balanceMap[transaction.payer] === undefined) {
                    balanceMap[transaction.payer] = this.getLatestBalanceFromChain(transaction.payer);
                }
                balanceMap[transaction.payer] -= transaction.amount;
            }
            if (transaction.payee !== this.blockchainMintAddress) {
                if (balanceMap[transaction.payee] === undefined) {
                    balanceMap[transaction.payee] = this.getLatestBalanceFromChain(transaction.payee);
                }
                balanceMap[transaction.payee] += transaction.amount;
            }
        });
        return Object.keys(balanceMap).map((address) => new AccountBalance(address, balanceMap[address]));
    }
    applyCreditRewards(transaction, block) {
        if (transaction.payer !== this.blockchainMintAddress &&
            !transaction.payee.startsWith("sc_") &&
            !transaction.payer.startsWith("sc_")) {
            const payerInLast1Block = this.wasPayerInLastBlocks(transaction.payer, 1);
            const payerInLast2Blocks = this.wasPayerInLastBlocks(transaction.payer, 2);
            if (payerInLast2Blocks) {
                block.creditLedger.push(new Credit(-50, transaction.payer, "Penalty for frequent transactions"));
            }
            else if (!payerInLast1Block) {
                block.creditLedger.push(new Credit(10, transaction.payer, "Network Participation"));
                block.creditLedger.push(new Credit(10, transaction.payee, "Network Participation"));
            }
            else {
                console.log(`Payer ${transaction.payer} was involved in a transaction in the last block, no credits rewarded.`);
            }
        }
        else if (transaction.payer === this.blockchainMintAddress) {
            const currentCreditScore = this.getLatestCreditScoreFromChain(transaction.payee);
            const halvedCreditScore = currentCreditScore / 2;
            block.creditLedger.push(new Credit(-halvedCreditScore, transaction.payee, "Credit Halved From Minting Tokens"));
        }
    }
    async proposeBlock() {
        const lastBlock = this.lastBlock;
        const lastBlockHash = lastBlock.hash;
        const selectedValidator = this.selectDeterministicValidator(lastBlockHash);
        if (!selectedValidator) {
            console.log("No eligible validator available to propose the block.");
            return;
        }
        console.log(selectedValidator, " has been selected as the Block Proposer");
        const minerCreditScore = this.getLatestCreditScoreFromChain(selectedValidator);
        const miningCap = this.getMiningThreshold();
        if (minerCreditScore < miningCap) {
            console.log(`⛔ Mining restriction: Validator requires at least ${miningCap} credit score.`);
            return;
        }
        // Execute smart contracts before proposing the block
        console.log("Executing Smart Contracts in Transaction Pool...");
        this.executeSmartContractsInBlock(lastBlock);
        // Wait for the block time to allow the transfer pool to build up
        await this.delay(this.blockTime);
        const newBlock = new Block(this.chain.length, lastBlockHash, [...this.transactionPool], [], [], [], [...this.contractPool]);
        // Apply transfers and credit rewards
        for (const transfer of newBlock.transactions) {
            this.applyTransfer(transfer, newBlock);
            this.applyCreditRewards(transfer, newBlock);
        }
        this.rewardValidator(selectedValidator, newBlock);
        // Consolidate account balances and credit scores
        newBlock.accountBalances = this.consolidateAccountBalances(newBlock.transactions);
        newBlock.creditScores = this.consolidateCreditScores(newBlock.creditLedger);
        this.chain.push(newBlock);
        console.log(`Block proposed and added by ${selectedValidator}:`, newBlock);
        // Clear transfer pool and pending balances
        this.transactionPool = [];
        this.contractPool = [];
        this.pendingBalances = {};
        this.proposeBlock();
    }
    executeSmartContractsInBlock(block) {
        var _a;
        // Iterate over a copy of the transactions array because it may be modified
        const transactionsToProcess = [...block.transactions];
        for (const transaction of transactionsToProcess) {
            if (transaction.payee.startsWith("sc_")) {
                const contractAddress = transaction.payee;
                let contract;
                // Search for the contract in the block's contracts
                contract = block.contracts.find((c) => c.address === contractAddress);
                if (!contract) {
                    // If not found in the current block, search in the chain
                    contract = this.findContractInChain(contractAddress);
                }
                if (contract) {
                    console.log(`Executing contract at address ${contract.address} initiated by ${transaction.payer}`);
                    // Extract arguments from the transaction metadata, if available
                    const args = ((_a = transaction.metadata) === null || _a === void 0 ? void 0 : _a.args) || [];
                    // Execute the smart contract with the extracted arguments and the payer as the caller
                    try {
                        const { result, transactions: contractTransactions } = contract.execute(args, transaction.payer, block.hash);
                        // Process the transactions generated by the contract
                        for (const contractTx of contractTransactions) {
                            // Ensure the contract has sufficient balance to send the money
                            const contractBalance = this.getPendingBalance(contractTx.payer);
                            if (contractBalance < contractTx.amount) {
                                console.log(`Smart contract ${contractTx.payer} has insufficient funds to send ${contractTx.amount}. Transaction aborted.`);
                                continue;
                            }
                            // Update pending balances
                            this.updatePendingBalance(contractTx.payer, contractTx.payee, contractTx.amount);
                            // Add to block's transactions
                            this.transactionPool.push(contractTx);
                            console.log(`Smart contract ${contract.address} sent ${contractTx.amount} to ${contractTx.payee}`);
                        }
                    }
                    catch (e) {
                        console.error(`Error executing contract ${contract.address}:`, e);
                    }
                }
                else {
                    console.log(`Contract at address ${transaction.payee} not found in the chain.`);
                }
            }
        }
    }
    // Helper method to find a contract in the chain
    findContractInChain(contractAddress) {
        for (let i = this.chain.length - 1; i >= 0; i--) {
            const block = this.chain[i];
            const contract = block.contracts.find((c) => c.address === contractAddress);
            if (contract) {
                return contract;
            }
        }
        return undefined;
    }
    consolidateCreditScores(creditLedger) {
        const scoreMap = {};
        creditLedger.forEach((credit) => {
            // Exclude transactions to blockchain mint and addresses starting with "sc_"
            if (credit.receiver !== this.blockchainMintAddress &&
                !credit.receiver.startsWith("sc_")) {
                if (scoreMap[credit.receiver]) {
                    scoreMap[credit.receiver] += credit.amount;
                }
                else {
                    scoreMap[credit.receiver] = credit.amount;
                }
            }
        });
        const updatedScores = Object.keys(scoreMap).map((address) => {
            const mostRecentCreditScore = this.getLatestCreditScoreFromChain(address);
            const updatedScore = mostRecentCreditScore + scoreMap[address];
            return new CreditScore(address, updatedScore);
        });
        // Also filter out blockchain mint and addresses starting with "sc_" in the final result
        return updatedScores.filter((creditScore) => creditScore.address !== this.blockchainMintAddress &&
            !creditScore.address.startsWith("sc_"));
    }
    rewardValidator(validatorAddress, block) {
        const validatorCredit = new Credit(this.blockCreditReward, validatorAddress, "Block Reward");
        block.creditLedger.push(validatorCredit);
    }
    wasPayerInLastBlocks(address, blocksToCheck) {
        const chainLength = this.chain.length;
        for (let i = chainLength - 1; i >= Math.max(0, chainLength - blocksToCheck); i--) {
            const block = this.chain[i];
            if (block.transactions.some((t) => t.payer === address)) {
                return true;
            }
        }
        return false;
    }
    getCurrentMintingReward() {
        const length = this.chain.length;
        const blocksPerInterval = 2000000; // Every 2,000,000 blocks
        const intervalsPassed = Math.floor(length / blocksPerInterval);
        // Calculate the current reward by halving the reward for each interval passed
        const currentReward = Math.max(this.initialMintingReward / Math.pow(2, intervalsPassed), this.minimumReward);
        return Math.floor(currentReward);
    }
}
Chain.instance = new Chain();
// Wallet class
class Wallet {
    constructor() {
        this.IDPrepend = "pc_";
        const keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        this.publicKey = keyPair.publicKey;
        this.privateKey = keyPair.privateKey;
        const hashedPublicKey = crypto
            .createHash("sha256")
            .update(this.publicKey)
            .digest("hex");
        this.address =
            this.IDPrepend + hashedPublicKey.slice(0, 30 - this.IDPrepend.length);
    }
    sendMoney(amount, payeeAddress) {
        const payerBalance = Chain.instance.getPendingBalance(this.address);
        if (payerBalance < amount) {
            console.log(`Transaction failed: Insufficient funds. ${this.address} tried to send ${amount}, but only has ${payerBalance}.`);
            return;
        }
        try {
            const transaction = new Transaction(amount, this.address, payeeAddress);
            const sign = crypto.createSign("SHA256");
            sign.update(transaction.toString()).end();
            const signature = sign.sign(this.privateKey);
            Chain.instance.addTransferToPool(transaction, this.publicKey, signature);
        }
        catch (e) {
            console.error(`Transaction failed: ${e}`);
        }
    }
    mintTokens() {
        const currentCreditScore = Chain.instance.getLatestCreditScoreFromChain(this.address);
        if (currentCreditScore < 1000) {
            console.log("Minting failed: insufficient credit score.");
            return;
        }
        const reward = Chain.instance.getCurrentMintingReward();
        const mintTransfer = new Transaction(reward, Chain.instance.blockchainMintAddress, this.address);
        Chain.instance.addTransferToPool(mintTransfer, "", Buffer.alloc(0));
        console.log(`Minted ${reward} tokens for ${this.address}`);
    }
    executeSmartContract(contractAddress, value, args) {
        return Chain.instance.executeSmartContract(contractAddress, value, args, this.address);
    }
    publishSmartContract(contract) {
        contract.setPublisherAddress(this.address);
        return Chain.instance.addSmartContractToPool(contract, this.address);
    }
}
// Node class representing a node in the network that proposes blocks
class Node {
    constructor(wallet) {
        this.wallet = wallet;
        Chain.instance.addMiner(wallet.address);
    }
}
// Instantiate nodes and wallets
const miner = new Wallet();
const minerNode = new Node(miner);
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
(async () => {
    const code = `
    const [amount, recipient] = args;
    
    // Ensure Bob (caller) has enough tokens
    const balance = chain.getPendingBalance(caller);
    
    if (balance < amount) {
      throw new Error('Insufficient funds');
    }
    
    // Transfer tokens from contract to the recipient (Miner)
    sendMoney(amount, recipient);
  `;
    // const contract = new SmartContract(code);
    // await delay(17000);
    // bob.publishSmartContract(contract);
    // bob.mintTokens();
    // await delay(15500);
    // bob.executeSmartContract(contract.address!, 5, [5, miner.address]);
    // await delay(25000);
    // bob.sendMoney(5, miner.address);
})();
