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
class Transfer {
    constructor(amount, payer, // Public Key of the sender
    payee // Public Key of the receiver
    ) {
        this.amount = amount;
        this.payer = payer;
        this.payee = payee;
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
    constructor(amount, receiver, // Public Key of the receiver for credits/penalties
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
    constructor(publicKey, balance = 0) {
        this.publicKey = publicKey;
        this.balance = balance;
    }
    increase(amount) {
        this.balance += amount;
    }
    decrease(amount) {
        if (this.balance < amount) {
            throw new Error("Insufficient funds.");
        }
        this.balance -= amount;
    }
}
// CreditScore class to hold credit score for each account
class CreditScore {
    constructor(publicKey, score = 500) {
        this.publicKey = publicKey;
        this.score = score;
    }
    increase(amount) {
        this.score += amount;
    }
    decrease(amount) {
        this.score -= amount;
    }
}
// Block class with both Transfer and Credit functionality
class Block {
    constructor(index, prevHash, transfers, // Separate array for transfers
    accountBalances, // List of updated account balances
    creditLedger, // Separate array for rewards and penalties
    creditScores, // List of updated credit scores
    timestamp = Date.now()) {
        this.index = index;
        this.prevHash = prevHash;
        this.transfers = transfers;
        this.accountBalances = accountBalances;
        this.creditLedger = creditLedger;
        this.creditScores = creditScores;
        this.timestamp = timestamp;
        this.nonce = Math.round(Math.random() * 999999);
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
        this.chain = []; // Initially no blocks (Genesis Block created on demand)
        this.transferPool = []; // Pool to store pending transfers
        this.blockchainMintAddress = "Blockchain Mint"; // Special mint address
    }
    get lastBlock() {
        return this.chain[this.chain.length - 1];
    }
    // Mine a block
    mine(nonce) {
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
    getLatestBalanceFromChain(publicKey) {
        for (let i = this.chain.length - 1; i >= 0; i--) {
            const block = this.chain[i];
            const accountBalance = block.accountBalances.find((ab) => ab.publicKey === publicKey);
            if (accountBalance) {
                return accountBalance.balance;
            }
        }
        return 0; // Default balance is 0 if no prior transactions
    }
    // Helper to find the latest credit score for a user by going backwards through the chain
    getLatestCreditScoreFromChain(publicKey) {
        let creditScore = 500; // Default credit score
        for (let i = this.chain.length - 1; i >= 0; i--) {
            const block = this.chain[i];
            const creditScoreInBlock = block.creditScores.find((cs) => cs.publicKey === publicKey);
            if (creditScoreInBlock) {
                creditScore = creditScoreInBlock.score;
                break; // Use the latest found credit score
            }
        }
        return creditScore;
    }
    // Helper to check if the payer was involved in the last 1 or 2 blocks
    wasPayerInLastBlocks(publicKey, blocksToCheck) {
        const chainLength = this.chain.length;
        for (let i = chainLength - 1; i >= Math.max(0, chainLength - blocksToCheck); i--) {
            const block = this.chain[i];
            if (block.transfers.some((t) => t.payer === publicKey)) {
                return true;
            }
        }
        return false;
    }
    // Apply a transfer and update account balances
    applyTransfer(transfer, block) {
        const payerBalance = this.getLatestBalanceFromChain(transfer.payer);
        const payeeBalance = this.getLatestBalanceFromChain(transfer.payee);
        if (payerBalance < transfer.amount &&
            transfer.payer !== this.blockchainMintAddress) {
            throw new Error("Insufficient funds for this transfer.");
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
    addTransferToPool(transfer) {
        this.transferPool.push(transfer);
    }
    // Mint tokens to a given public key and add to the transfer pool
    mintTokens(mintAmount, receiverPublicKey) {
        const mintTransfer = new Transfer(mintAmount, this.blockchainMintAddress, receiverPublicKey);
        this.addTransferToPool(mintTransfer);
        console.log(`Minted ${mintAmount} tokens to ${receiverPublicKey}`);
    }
    // Consolidate balances before pushing the block
    consolidateAccountBalances(accountBalances, transfers) {
        const balanceMap = {};
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
                }
                else {
                    balanceMap[transfer.payer] = -transfer.amount;
                }
            }
            if (balanceMap[transfer.payee] !== undefined) {
                balanceMap[transfer.payee] += transfer.amount;
            }
            else {
                balanceMap[transfer.payee] = transfer.amount;
            }
        });
        return Object.keys(balanceMap).map((key) => new AccountBalance(key, balanceMap[key]));
    }
    // Consolidate credit scores and add rewards or penalties
    consolidateCreditScores(creditScores, creditLedger) {
        const scoreMap = {};
        // Process credits in the current block's ledger to update the score map
        creditLedger.forEach((credit) => {
            if (scoreMap[credit.receiver]) {
                scoreMap[credit.receiver] += credit.amount;
            }
            else {
                scoreMap[credit.receiver] = credit.amount;
            }
        });
        // Now, for each unique receiver in the ledger, we get their latest credit score from the chain
        const updatedScores = Object.keys(scoreMap).map((publicKey) => {
            const mostRecentCreditScore = this.getLatestCreditScoreFromChain(publicKey);
            // Update the score by adding the current block's ledger amounts to the most recent score
            const updatedScore = mostRecentCreditScore + scoreMap[publicKey];
            return new CreditScore(publicKey, updatedScore);
        });
        return updatedScores;
    }
    // Reward miner credits and add to credit ledger
    rewardMiner(minerWallet, block) {
        const miningReward = 100;
        const minerCredit = new Credit(miningReward, minerWallet.publicKey, "Mining Reward");
        block.creditLedger.push(minerCredit);
    }
    // Apply credit earning rules
    applyCreditRewards(transfer, block) {
        if (transfer.payer !== this.blockchainMintAddress) {
            // Check if the payer had transactions in the last block or two blocks ago
            const payerInLast1Block = this.wasPayerInLastBlocks(transfer.payer, 1);
            const payerInLast2Blocks = this.wasPayerInLastBlocks(transfer.payer, 2);
            if (payerInLast2Blocks) {
                // Subtract 50 credits if the payer was in the last 2 blocks
                block.creditLedger.push(new Credit(-50, transfer.payer, "Penalty for frequent transactions"));
            }
            else if (!payerInLast1Block) {
                // Reward both payer and payee if they weren't in the last block
                block.creditLedger.push(new Credit(10, transfer.payer, "Credit for transaction"));
                block.creditLedger.push(new Credit(10, transfer.payee, "Credit for transaction"));
            }
            else {
                // No rewards if the payer was in the last block
                console.log(`Payer ${transfer.payer} was involved in a transaction in the last block, no credits rewarded.`);
            }
        }
    }
    // Mine a block
    mineBlock(minerWallet) {
        const minerCreditScore = this.getLatestCreditScoreFromChain(minerWallet.publicKey);
        if (this.chain.length > 0 && minerCreditScore < 1000) {
            console.log("⛔ Mining restriction: Miner requires at least 1000 credit score.");
            return;
        }
        if (this.chain.length === 0) {
            console.log("🚀 Creating the Genesis Block...");
            const genesisBlock = new Block("Genesis", null, [], // No transfers
            [], // No account balances
            [new Credit(500, minerWallet.publicKey, "Genesis Mining Reward")], // Initial credit ledger
            [
                new CreditScore(minerWallet.publicKey, this.getLatestCreditScoreFromChain(minerWallet.publicKey) + 500),
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
        const newBlock = new Block(this.chain.length, this.lastBlock.hash, [...this.transferPool], [], // Empty balances initially
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
        newBlock.creditScores = this.consolidateCreditScores(newBlock.creditScores, newBlock.creditLedger);
        this.mine(newBlock.nonce);
        console.log("Block mined:", newBlock);
        // Push the mined block to the chain
        this.chain.push(newBlock);
        // Clear the transfer pool
        this.transferPool = [];
    }
}
Chain.instance = new Chain();
// Wallet class
class Wallet {
    constructor() {
        const keyPair = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        this.publicKey = keyPair.publicKey;
        this.privateKey = keyPair.privateKey;
    }
    sendMoney(amount, payeePublicKey) {
        const transfer = new Transfer(amount, this.publicKey, payeePublicKey);
        Chain.instance.addTransferToPool(transfer);
    }
}
// Node class representing a node in the network that mines blocks
class Node {
    constructor(wallet) {
        this.blocksMined = 0;
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
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// Execute the minting and block mining
(async () => {
    await mintAndPushBlock();
    await delay(10000);
    miner.sendMoney(100, bob.publicKey);
})();
