import { Telegraf, session } from 'telegraf';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';
import cron from 'node-cron';
import fs from 'fs';
import 'dotenv/config';

// Database setup
const adapter = new JSONFile('db.json');
const db = new Low(adapter, {});

// Initialize database
await db.read();
db.data ||= { 
  users: [], 
  pendingPurchases: [], 
  withdraws: [], 
  admin: { id: parseInt(process.env.ADMIN_ID), broadcasts: [] } 
};
await db.write();

// Constants
const MIN_WITHDRAW = 100;
const PACKAGES = {
  'Basic': { price: 1500, commission: 200 },
  'Premium': { price: 3000, commission: 400 },
  'VIP': { price: 3500, commission: 500 }
};

// Bot setup
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// In-memory user sessions for withdrawal process
const userSessions = {};

// Utility functions
function isAdmin(ctx) {
  return String(ctx.from?.id) === String(process.env.ADMIN_ID);
}

function generateReferralCode() {
  return nanoid(6);
}

function findUserById(userId) {
  return db.data.users.find(user => user.id === userId);
}

function findUserByReferralCode(code) {
  return db.data.users.find(user => user.referralCode === code);
}

function findPendingPurchase(userId, packageName) {
  return db.data.pendingPurchases.find(
    purchase => purchase.userId === userId && purchase.package === packageName
  );
}

function findWithdrawRequest(id) {
  return db.data.withdraws.find(withdraw => withdraw.id === id);
}

async function saveDB() {
  try {
    await db.write();
    
    // Create backup
    const backupsDir = 'backups';
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${backupsDir}/db_${timestamp}.json`;
    
    if (fs.existsSync('db.json')) {
      fs.copyFileSync('db.json', backupPath);
      console.log(`💾 Backup saved: ${backupPath}`);
    }
  } catch (err) {
    console.error('❌ Failed to save database:', err);
  }
}

async function registerUser(ctx) {
  const userId = ctx.from.id;
  const name = `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}`;
  const referralCode = ctx.startPayload;
  
  let user = findUserById(userId);
  
  if (!user) {
    user = {
      id: userId,
      name: name,
      referralCode: generateReferralCode(),
      referredBy: null,
      balance: 0,
      package: null,
      createdAt: new Date().toISOString()
    };
    
    // Handle referral if provided
    if (referralCode) {
      const referrer = findUserByReferralCode(referralCode);
      if (referrer) {
        user.referredBy = referralCode;
        try {
          await ctx.telegram.sendMessage(
            referrer.id,
            `👋 Someone joined using your referral link!`
          );
        } catch (error) {
          console.log('Could not notify referrer:', error.message);
        }
      }
    }
    
    db.data.users.push(user);
    await saveDB();
  }
  
  return user;
}

async function createWithdrawRequest(userId, amount, paymentMethod) {
  const user = findUserById(userId);
  if (!user || user.balance < amount) return null;
  
  user.balance -= amount;
  
  const withdrawRequest = {
    id: nanoid(8),
    userId: userId,
    amount: amount,
    paymentMethod: paymentMethod,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  db.data.withdraws.push(withdrawRequest);
  await saveDB();
  
  return withdrawRequest;
}

async function approveWithdrawRequest(withdrawId, note = '') {
  const request = findWithdrawRequest(withdrawId);
  if (!request || request.status !== 'pending') return false;
  
  request.status = 'approved';
  request.note = note;
  request.updatedAt = new Date().toISOString();
  await saveDB();
  
  try {
    await bot.telegram.sendMessage(
      request.userId,
      `✅ Your withdrawal of ${request.amount} ETB has been approved.${note ? '\nNote: ' + note : ''}`
    );
  } catch (error) {
    console.log('Could not notify user:', error.message);
  }
  
  return true;
}

async function rejectWithdrawRequest(withdrawId, reason = '') {
  const request = findWithdrawRequest(withdrawId);
  if (!request || request.status !== 'pending') return false;
  
  // Return funds to user
  const user = findUserById(request.userId);
  if (user) {
    user.balance += request.amount;
  }
  
  request.status = 'rejected';
  request.note = reason;
  request.updatedAt = new Date().toISOString();
  await saveDB();
  
  try {
    await bot.telegram.sendMessage(
      request.userId,
      `❌ Your withdrawal request of ${request.amount} ETB was rejected.${reason ? '\nReason: ' + reason : ''}`
    );
  } catch (error) {
    console.log('Could not notify user:', error.message);
  }
  
  return true;
}

async function confirmPurchase(userId, packageName) {
  const user = findUserById(userId);
  if (!user) return false;
  
  user.package = packageName;
  user.packageConfirmedAt = new Date().toISOString();
  
  // Pay referral commission
  if (user.referredBy) {
    const referrer = findUserByReferralCode(user.referredBy);
    if (referrer && PACKAGES[packageName]) {
      referrer.balance += PACKAGES[packageName].commission;
      try {
        await bot.telegram.sendMessage(
          referrer.id,
          `💰 You earned ${PACKAGES[packageName].commission} ETB commission from ${user.name}'s ${packageName} package purchase!`
        );
      } catch (error) {
        console.log('Could not notify referrer:', error.message);
      }
    }
  }
  
  // Remove from pending purchases
  db.data.pendingPurchases = db.data.pendingPurchases.filter(
    purchase => !(purchase.userId === userId && purchase.package === packageName)
  );
  
  await saveDB();
  return true;
}

// Scheduled backup every hour
cron.schedule('0 * * * *', () => {
  console.log('Running scheduled backup...');
  saveDB();
});

// User commands
bot.start(async (ctx) => {
  const user = await registerUser(ctx);
  const referralLink = `https://t.me/${ctx.botInfo.username}?start=${user.referralCode}`;
  
  await ctx.reply(
    `👋 Welcome, ${user.name}!\n\n` +
    `Your referral link:\n${referralLink}\n\n` +
    `Use /packages to see available website packages.`
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `🤖 Popposite Referral Bot Help\n\n` +
    `User Commands:\n` +
    `/start - Register and get started\n` +
    `/help - Show this help message\n` +
    `/packages - View available packages\n` +
    `/order - How to order instructions\n` +
    `/referral - Get your referral link\n` +
    `/myrefs - View your referrals\n` +
    `/balance - Check your balance\n` +
    `/withdraw - Request withdrawal\n` +
    `/myid - Show your Telegram ID\n\n` +
    `Admin Commands: /users, /user, /add_pending, /pending, /confirm, /refs, /withdrawals, /approve, /reject, /broadcast, /stats, /sales, /setpackage`
  );
});

bot.command('packages', (ctx) => {
  let message = `🧾 Packages\n\n`;
  for (const [name, details] of Object.entries(PACKAGES)) {
    message += `🔸 ${name} — ${details.price} ETB — Commission: ${details.commission} ETB\n`;
  }
  message += `\nNote: Pre-payment required. Contact admin to pay and confirm.`;
  ctx.reply(message);
});

bot.command('order', (ctx) => {
  ctx.reply(
    `📦 How to Order:\n\n` +
    `1. Choose a package using /packages\n` +
    `2. Send payment to the admin\n` +
    `3. Admin will confirm your purchase\n` +
    `4. Start earning from referrals!\n\n` +
    `Contact admin for payment details.`
  );
});

bot.command('referral', async (ctx) => {
  const user = findUserById(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Please /start first to register.');
  }
  
  const referralLink = `https://t.me/${ctx.botInfo.username}?start=${user.referralCode}`;
  ctx.reply(`🔗 Your referral link:\n${referralLink}`);
});

bot.command('myrefs', async (ctx) => {
  const user = findUserById(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Please /start first to register.');
  }
  
  const referrals = db.data.users.filter(u => u.referredBy === user.referralCode);
  
  if (referrals.length === 0) {
    return ctx.reply('👥 You have no referrals yet.');
  }
  
  let message = '👥 Your referrals:\n';
  referrals.forEach(ref => {
    message += `- ${ref.name} (ID: ${ref.id}) — ${ref.package || 'Pending'} ${ref.package ? '✅' : '❌'}\n`;
  });
  
  ctx.reply(message);
});

bot.command('balance', async (ctx) => {
  const user = findUserById(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Please /start first to register.');
  }
  
  const referrals = db.data.users.filter(u => u.referredBy === user.referralCode);
  const referralLink = `https://t.me/${ctx.botInfo.username}?start=${user.referralCode}`;
  
  let message = `💰 Your balance: ${user.balance} ETB\n\n`;
  message += `👥 Referrals: ${referrals.length}\n`;
  message += `🔗 Referral link:\n${referralLink}`;
  
  ctx.reply(message);
});

bot.command('withdraw', (ctx) => {
  const user = findUserById(ctx.from.id);
  if (!user) {
    return ctx.reply('❌ Please /start first to register.');
  }
  
  if (user.balance < MIN_WITHDRAW) {
    return ctx.reply(`⚠️ Minimum withdraw is ${MIN_WITHDRAW} ETB. Your balance: ${user.balance} ETB`);
  }
  
  userSessions[ctx.from.id] = { action: 'withdraw', step: 'amount' };
  ctx.reply(`💰 Enter the amount you want to withdraw (must end with 00), or type 'cancel' to abort.`);
});

bot.command('myid', (ctx) => {
  ctx.reply(`Your ID: ${ctx.from.id}`);
});

// Admin commands
bot.command('users', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  if (db.data.users.length === 0) {
    return ctx.reply('No users registered yet.');
  }
  
  let message = '👥 Users:\n\n';
  db.data.users.forEach(user => {
    message += `ID: ${user.id} | ${user.name} | ${user.package || 'No Package'} | Balance: ${user.balance} ETB\n`;
  });
  
  ctx.reply(message);
});

bot.command('user', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage: /user <userId>');
  }
  
  const userId = parseInt(args[0]);
  if (isNaN(userId)) {
    return ctx.reply('❌ Invalid user ID.');
  }
  
  const user = findUserById(userId);
  if (!user) {
    return ctx.reply('❌ User not found.');
  }
  
  const referrals = db.data.users.filter(u => u.referredBy === user.referralCode);
  
  let message = `👤 User Details:\n\n`;
  message += `ID: ${user.id}\n`;
  message += `Name: ${user.name}\n`;
  message += `Package: ${user.package || 'None'}\n`;
  message += `Balance: ${user.balance} ETB\n`;
  message += `Referral Code: ${user.referralCode}\n`;
  message += `Referred By: ${user.referredBy || 'None'}\n`;
  message += `Joined: ${new Date(user.createdAt).toLocaleDateString()}\n\n`;
  message += `Referrals: ${referrals.length}\n`;
  
  referrals.forEach(ref => {
    message += `- ${ref.name} (${ref.package || 'Pending'})\n`;
  });
  
  ctx.reply(message);
});

bot.command('add_pending', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /add_pending <userId> <package> [note]');
  }
  
  const userId = parseInt(args[0]);
  const packageName = args[1];
  const note = args.slice(2).join(' ') || '';
  
  if (isNaN(userId)) {
    return ctx.reply('❌ Invalid user ID.');
  }
  
  if (!PACKAGES[packageName]) {
    return ctx.reply('❌ Invalid package. Available: ' + Object.keys(PACKAGES).join(', '));
  }
  
  const user = findUserById(userId);
  if (!user) {
    return ctx.reply('❌ User not found.');
  }
  
  const pendingPurchase = {
    id: nanoid(8),
    userId: userId,
    package: packageName,
    note: note,
    createdAt: new Date().toISOString()
  };
  
  db.data.pendingPurchases.push(pendingPurchase);
  await saveDB();
  
  try {
    await ctx.telegram.sendMessage(
      userId,
      `📦 Your ${packageName} package purchase is pending admin confirmation.`
    );
  } catch (error) {
    console.log('Could not notify user:', error.message);
  }
  
  ctx.reply(`✅ Added pending purchase for user ${userId}`);
});

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  if (db.data.pendingPurchases.length === 0) {
    return ctx.reply('No pending purchases.');
  }
  
  let message = '📦 Pending Purchases:\n\n';
  db.data.pendingPurchases.forEach(purchase => {
    const user = findUserById(purchase.userId);
    message += `ID: ${purchase.id} | User: ${user?.name || purchase.userId} | Package: ${purchase.package} | Note: ${purchase.note}\n`;
  });
  
  ctx.reply(message);
});

bot.command('confirm', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /confirm <userId> <package>');
  }
  
  const userId = parseInt(args[0]);
  const packageName = args[1];
  
  if (isNaN(userId)) {
    return ctx.reply('❌ Invalid user ID.');
  }
  
  if (!PACKAGES[packageName]) {
    return ctx.reply('❌ Invalid package. Available: ' + Object.keys(PACKAGES).join(', '));
  }
  
  const success = await confirmPurchase(userId, packageName);
  if (!success) {
    return ctx.reply('❌ Failed to confirm purchase. User not found.');
  }
  
  try {
    await ctx.telegram.sendMessage(
      userId,
      `✅ Your ${packageName} package has been confirmed! You can now start earning from referrals.`
    );
  } catch (error) {
    console.log('Could not notify user:', error.message);
  }
  
  ctx.reply(`✅ Package confirmed for user ${userId}`);
});

bot.command('refs', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage: /refs <userId>');
  }
  
  const userId = parseInt(args[0]);
  if (isNaN(userId)) {
    return ctx.reply('❌ Invalid user ID.');
  }
  
  const user = findUserById(userId);
  if (!user) {
    return ctx.reply('❌ User not found.');
  }
  
  const referrals = db.data.users.filter(u => u.referredBy === user.referralCode);
  
  if (referrals.length === 0) {
    return ctx.reply('This user has no referrals.');
  }
  
  let message = `👥 Referrals of ${user.name}:\n\n`;
  referrals.forEach(ref => {
    message += `- ${ref.name} (ID: ${ref.id}) — ${ref.package || 'Pending'} ${ref.package ? '✅' : '❌'}\n`;
  });
  
  ctx.reply(message);
});

bot.command('withdrawals', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  if (db.data.withdraws.length === 0) {
    return ctx.reply('No withdrawal requests.');
  }
  
  let message = '💳 Withdrawal Requests:\n\n';
  db.data.withdraws.forEach(withdraw => {
    const user = findUserById(withdraw.userId);
    message += `ID: ${withdraw.id} | User: ${user?.name || withdraw.userId} | Amount: ${withdraw.amount} ETB | Method: ${withdraw.paymentMethod} | Status: ${withdraw.status}\n`;
  });
  
  ctx.reply(message);
});

bot.command('approve', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage: /approve <withdrawId> [note]');
  }
  
  const withdrawId = args[0];
  const note = args.slice(1).join(' ') || '';
  
  const success = await approveWithdrawRequest(withdrawId, note);
  if (!success) {
    return ctx.reply('❌ Withdraw request not found or not pending.');
  }
  
  ctx.reply('✅ Withdrawal approved.');
});

bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage: /reject <withdrawId> [reason]');
  }
  
  const withdrawId = args[0];
  const reason = args.slice(1).join(' ') || '';
  
  const success = await rejectWithdrawRequest(withdrawId, reason);
  if (!success) {
    return ctx.reply('❌ Withdraw request not found or not pending.');
  }
  
  ctx.reply('✅ Withdrawal rejected.');
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const message = ctx.message.text.split(' ').slice(1).join(' ');
  if (!message) {
    return ctx.reply('Usage: /broadcast <message>');
  }
  
  let successCount = 0;
  let failCount = 0;
  
  for (const user of db.data.users) {
    try {
      await ctx.telegram.sendMessage(user.id, `📢 Broadcast from admin:\n\n${message}`);
      successCount++;
    } catch (error) {
      failCount++;
      console.log(`Could not send to user ${user.id}:`, error.message);
    }
  }
  
  db.data.admin.broadcasts.push({
    message: message,
    sentAt: new Date().toISOString(),
    success: successCount,
    failed: failCount
  });
  await saveDB();
  
  ctx.reply(`📢 Broadcast sent to ${successCount} users. Failed: ${failCount}`);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const totalUsers = db.data.users.length;
  const activeUsers = db.data.users.filter(u => u.package).length;
  const pendingPurchases = db.data.pendingPurchases.length;
  const pendingWithdrawals = db.data.withdraws.filter(w => w.status === 'pending').length;
  
  let totalCommission = 0;
  db.data.users.forEach(user => {
    totalCommission += user.balance;
  });
  
  ctx.reply(
    `📊 Bot Statistics:\n\n` +
    `Total Users: ${totalUsers}\n` +
    `Active Users: ${activeUsers}\n` +
    `Pending Purchases: ${pendingPurchases}\n` +
    `Pending Withdrawals: ${pendingWithdrawals}\n` +
    `Total Commission Held: ${totalCommission} ETB`
  );
});

bot.command('sales', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const sales = {};
  db.data.users.forEach(user => {
    if (user.package) {
      sales[user.package] = (sales[user.package] || 0) + 1;
    }
  });
  
  let message = '📈 Sales by Package:\n\n';
  for (const [packageName, count] of Object.entries(sales)) {
    message += `${packageName}: ${count} sales\n`;
  }
  
  if (Object.keys(sales).length === 0) {
    message += 'No sales yet.';
  }
  
  ctx.reply(message);
});

bot.command('setpackage', async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ You are not authorized.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /setpackage <userId> <package>');
  }
  
  const userId = parseInt(args[0]);
  const packageName = args[1];
  
  if (isNaN(userId)) {
    return ctx.reply('❌ Invalid user ID.');
  }
  
  if (!PACKAGES[packageName]) {
    return ctx.reply('❌ Invalid package. Available: ' + Object.keys(PACKAGES).join(', '));
  }
  
  const user = findUserById(userId);
  if (!user) {
    return ctx.reply('❌ User not found.');
  }
  
  user.package = packageName;
  user.packageConfirmedAt = new Date().toISOString();
  await saveDB();
  
  try {
    await ctx.telegram.sendMessage(
      userId,
      `✅ Admin has set your package to ${packageName}.`
    );
  } catch (error) {
    console.log('Could not notify user:', error.message);
  }
  
  ctx.reply(`✅ Package set for user ${userId}`);
});

// Handle text messages for withdrawal process
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const session = userSessions[userId];
  
  if (!session) return;
  
  if (text.toLowerCase() === 'cancel') {
    delete userSessions[userId];
    return ctx.reply('❌ Withdraw canceled.');
  }
  
  if (session.action === 'withdraw') {
    if (session.step === 'amount') {
      const amount = parseInt(text);
      
      if (isNaN(amount) || !text.endsWith('00')) {
        return ctx.reply('⚠️ Invalid amount. Must be a number ending with 00. Try again or type "cancel".');
      }
      
      const user = findUserById(userId);
      if (amount > user.balance) {
        delete userSessions[userId];
        return ctx.reply('⚠️ Insufficient balance. Withdraw canceled.');
      }
      
      if (amount < MIN_WITHDRAW) {
        delete userSessions[userId];
        return ctx.reply(`⚠️ Minimum withdraw is ${MIN_WITHDRAW} ETB. Withdraw canceled.`);
      }
      
      session.amount = amount;
      session.step = 'method';
      ctx.reply('💳 Choose payment method:\n1) Telebirr\n2) CBE\n3) Transfer\nOr type "cancel" to abort.');
      
    } else if (session.step === 'method') {
      let paymentMethod;
      
      if (text.includes('1') || text.toLowerCase().includes('telebirr')) {
        paymentMethod = 'Telebirr';
      } else if (text.includes('2') || text.toLowerCase().includes('cbe')) {
        paymentMethod = 'CBE';
      } else if (text.includes('3') || text.toLowerCase().includes('transfer')) {
        paymentMethod = 'Transfer';
      } else {
        return ctx.reply('⚠️ Invalid method. Choose 1, 2, or 3, or type "cancel".');
      }
      
      const withdrawRequest = await createWithdrawRequest(userId, session.amount, paymentMethod);
      
      if (withdrawRequest) {
        ctx.reply(`📩 Withdraw request submitted: ${session.amount} ETB via ${paymentMethod}. Admin will process it soon.`);
        
        // Notify admin
        const user = findUserById(userId);
        try {
          await ctx.telegram.sendMessage(
            process.env.ADMIN_ID,
            `🆕 New withdrawal request:\n\n` +
            `User: ${user.name} (ID: ${userId})\n` +
            `Amount: ${session.amount} ETB\n` +
            `Method: ${paymentMethod}\n` +
            `Request ID: ${withdrawRequest.id}`
          );
        } catch (error) {
          console.log('Could not notify admin:', error.message);
        }
      } else {
        ctx.reply('❌ Failed to create withdraw request. Please try again.');
      }
      
      delete userSessions[userId];
    }
  }
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('❌ An error occurred. Please try again later.');
});

// Start bot
console.log('🤖 Starting Popposite Referral Bot...');
bot.launch().then(() => {
  console.log('✅ Bot is running!');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));