const { Client, GatewayIntentBits, Events, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
require('dotenv').config();

const app = express();
const port = 3002;

// Discord クライアントの設定
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ]
});
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;

// データベースファイルのパスを指定
const dbPath = path.join(__dirname, 'voice_channel_time.db');

// データベース接続をグローバル変数として保持
let db;

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    // データベース接続を作成
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('データベース接続エラー:', err.message);
        reject(err);
        return;
      }
      console.log('データベースに接続しました。');
      
      // テーブルの存在をチェックし、必要に応じて作成
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS channel_user_time (
          channel_id TEXT,
          user_id TEXT,
          total_time INTEGER,
          last_join INTEGER,
          PRIMARY KEY (channel_id, user_id)
        )`, (err) => {
          if (err) {
            console.error('channel_user_time テーブル作成エラー:', err.message);
            reject(err);
          }
        });

        db.run(`CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          guild_id TEXT
        )`, (err) => {
          if (err) {
            console.error('channels テーブル作成エラー:', err.message);
            reject(err);
          } else {
            console.log('データベーステーブルの初期化が完了しました。');
            resolve();
          }
        });
      });
    });
  });
}

// アプリケーション終了時にデータベース接続を閉じる
function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) {
          console.error('データベース接続を閉じる際にエラーが発生しました:', err.message);
          reject(err);
        } else {
          console.log('データベース接続を閉じました。');
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

// チャート生成のための設定
const width = 800;
const height = 600;
const chartCallback = (ChartJS) => {
    ChartJS.defaults.responsive = true;
    ChartJS.defaults.maintainAspectRatio = false;
    // 日本語フォントの設定
    ChartJS.defaults.font.family = "'GenEiAntiqueNv5-M', sans-serif";
};
const chartJSNodeCanvas = new ChartJSNodeCanvas({ 
    width, 
    height, 
    chartCallback,
    plugins: {
        modern: ['chartjs-plugin-datalabels']
    }
});
// スラッシュコマンドの定義
const commands = [
  new SlashCommandBuilder()
    .setName('voicestats')
    .setDescription('ボイスチャンネルの利用統計を表示')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('統計の種類')
        .setRequired(true)
        .addChoices(
          { name: 'チャンネル別', value: 'channel' },
          { name: 'ユーザー別', value: 'user' }
        )
    ),
];
// フォントの登録
chartJSNodeCanvas.registerFont('./GenEiAntiqueNv5-M.ttf', { family: 'GenEiAntiqueNv5-M' });

client.once(Events.ClientReady, async () => {
  console.log('Bot is ready!');
  try {
    await client.application.commands.set(commands);
    console.log('Slash commands registered');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retryInteraction(interaction, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply();
      }
      return;
    } catch (error) {
      if ((error.code === 10062 || error.status === 503) && i < retries - 1) {
        await wait(1000 * (i + 1)); // 指数バックオフ
        continue;
      }
      throw error;
    }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'voicestats') {
    const type = interaction.options.getString('type');
    
    try {
      // 即座に応答を遅延させる
      await interaction.deferReply();

      if (type === 'channel') {
        await handleChannelStats(interaction);
      } else if (type === 'user') {
        await handleUserStats(interaction);
      }
    } catch (error) {
      console.error('Error handling voicestats command:', error);
      try {
        await interaction.editReply('統計の生成中にエラーが発生しました。しばらくしてからもう一度お試しください。');
      } catch (replyError) {
        console.error('Error sending error message:', replyError);
      }
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId = newState.member.id;
  const guildId = newState.guild.id;

  // ユーザーがボイスチャンネルに参加した場合
  if (!oldState.channelId && newState.channelId) {
    const channelId = newState.channelId;
    const joinTime = Date.now();

    // channels テーブルにチャンネル情報を追加または更新
    await new Promise((resolve, reject) => {
      db.run('INSERT OR REPLACE INTO channels (id, guild_id) VALUES (?, ?)', [channelId, guildId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // channel_user_time テーブルに参加情報を記録
    await new Promise((resolve, reject) => {
      db.run('INSERT OR REPLACE INTO channel_user_time (channel_id, user_id, total_time, last_join) VALUES (?, ?, COALESCE((SELECT total_time FROM channel_user_time WHERE channel_id = ? AND user_id = ?), 0), ?)',
        [channelId, userId, channelId, userId, joinTime], (err) => {
          if (err) reject(err);
          else resolve();
        });
    });
  }

  // ユーザーがボイスチャンネルから退出した場合
  if (oldState.channelId && !newState.channelId) {
    const channelId = oldState.channelId;
    const leaveTime = Date.now();

    // 滞在時間を計算し、データベースを更新
    await new Promise((resolve, reject) => {
      db.get('SELECT last_join, total_time FROM channel_user_time WHERE channel_id = ? AND user_id = ?', [channelId, userId], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          const duration = leaveTime - row.last_join;
          const newTotalTime = row.total_time + duration;
          db.run('UPDATE channel_user_time SET total_time = ?, last_join = NULL WHERE channel_id = ? AND user_id = ?',
            [newTotalTime, channelId, userId], (updateErr) => {
              if (updateErr) reject(updateErr);
              else resolve();
            });
        } else {
          resolve(); // ユーザーの記録が見つからない場合は何もしない
        }
      });
    });
  }
});

async function handleChannelStats(interaction) {
  try {
    const guildId = interaction.guildId;
    const rows = await new Promise((resolve, reject) => {
      db.all(`
        SELECT channel_id, SUM(total_time) as total_time
        FROM channel_user_time
        WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)
        GROUP BY channel_id
        ORDER BY total_time DESC
        LIMIT 10
      `, [guildId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (rows.length === 0) {
      return await interaction.editReply('このサーバーにはまだデータがありません。');
    }

    const channelNames = await Promise.all(rows.map(async row => {
      try {
        const channel = await client.channels.fetch(row.channel_id);
        return channel ? channel.name : 'Unknown Channel';
      } catch (error) {
        console.error(`Error fetching channel ${row.channel_id}:`, error);
        return 'Unknown Channel';
      }
    }));

    const data = {
      labels: channelNames,
      datasets: [{
        label: 'Total Time (hours)',
        data: rows.map(row => row.total_time / 3600000), // Convert ms to hours
        backgroundColor: 'rgba(54, 162, 235, 0.5)',
        borderColor: 'rgba(54, 162, 235, 1)',
        borderWidth: 1
      }]
    };

    const configuration = {
      type: 'bar',
      data: data,
      options: {
        scales: {
          y: {
              beginAtZero: true,
              title: {
                  display: true,
                  text: '合計時間 (時間)',
                  font: {
                      size: 14
                  }
              }
          },
          x: {
              ticks: {
                  font: {
                      size: 12
                  }
              }
          }
        },
        plugins: {
          title: {
              display: true,
              text: 'ボイスチャンネル使用統計',
              font: {
                  size: 18
              }
          },
          legend: {
              labels: {
                  font: {
                      size: 12
                  }
              }
          },
          datalabels: {
            anchor: 'end',
            align: 'top',
            font: {
                size: 10
            },
            formatter: (value) => value.toFixed(2) + '時間'
          }
        }
      }
    };

    const image = await chartJSNodeCanvas.renderToBuffer(configuration);
    const attachment = new AttachmentBuilder(image, { name: 'channel_stats.png' });
    await interaction.editReply({ files: [attachment] });

  } catch (error) {
    console.error('Error in handleChannelStats:', error);
    await interaction.editReply('チャンネル統計の生成中にエラーが発生しました。');
  }
}

async function handleUserStats(interaction) {
  try {
    const guildId = interaction.guildId;
    const rows = await new Promise((resolve, reject) => {
      db.all(`
        SELECT user_id, SUM(total_time) as total_time
        FROM channel_user_time
        WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)
        GROUP BY user_id
        ORDER BY total_time DESC
        LIMIT 10
      `, [guildId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (rows.length === 0) {
      return await interaction.editReply('このサーバーにはまだデータがありません。');
    }

    const userNames = await Promise.all(rows.map(async row => {
      const user = await client.users.fetch(row.user_id);
      return user ? user.username : 'Unknown User';
    }));

    const data = {
      labels: userNames,
      datasets: [{
        label: 'Total Time (hours)',
        data: rows.map(row => row.total_time / 3600000), // Convert ms to hours
        backgroundColor: 'rgba(255, 99, 132, 0.5)',
        borderColor: 'rgba(255, 99, 132, 1)',
        borderWidth: 1
      }]
    };

    const configuration = {
      type: 'bar',
      data: data,
      options: {
        scales: {
          y: {
              beginAtZero: true,
              title: {
                  display: true,
                  text: '合計時間 (時間)',
                  font: {
                      size: 14
                  }
              }
          },
          x: {
              ticks: {
                  font: {
                      size: 12
                  }
              }
          }
        },
        plugins: {
          title: {
              display: true,
              text: 'ボイスチャンネル使用統計',
              font: {
                  size: 18
              }
          },
          legend: {
              labels: {
                  font: {
                      size: 12
                  }
              }
          },
          datalabels: {
            anchor: 'end',
            align: 'top',
            font: {
                size: 10
            },
            formatter: (value) => value.toFixed(2) + '時間'
          }
        }
      }
    };


    const image = await chartJSNodeCanvas.renderToBuffer(configuration);
    const attachment = new AttachmentBuilder(image, { name: 'user_stats.png' });
    await interaction.editReply({ files: [attachment] });

  } catch (error) {
    console.error('Error in handleUserStats:', error);
    await interaction.editReply('ユーザー統計の生成中にエラーが発生しました。');
  }
}

// メインのアプリケーションコード
async function main() {
  try {
    await initializeDatabase();
    
    // Discord ボットの起動
    client.login(DISCORD_BOT_TOKEN);

    // HTTPサーバーのセットアップ
    const server = http.createServer(app);
    server.listen(port, '0.0.0.0', () => {
      console.log(`HTTP Server running on port ${port}`);
    });

  } catch (error) {
    console.error('アプリケーションの初期化中にエラーが発生しました:', error);
  }
}

// アプリケーションの終了処理
process.on('SIGINT', async () => {
  console.log('アプリケーションを終了しています...');
  await closeDatabase();
  process.exit(0);
});

// メイン関数を実行
main();
