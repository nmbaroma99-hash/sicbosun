const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const GAME_API_URL = 'https://api.wsktnus8.net/v2/history/getLastResult';
const DEFAULT_GAME_ID = 'ktrng_3979';
const DEFAULT_TABLE_ID = '39791215743193';

const HISTORY_FILE = 'game_history.json';
let historicalData = [];
let mlModels = { logistic: null, randomForest: null };
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 5 giây giữa các request

// Delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Giới hạn tốc độ request
async function rateLimitedRequest(config) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
    }
    lastRequestTime = Date.now();
    return axios(config);
}

// Cập nhật dữ liệu với retry
async function updateHistoricalData(retryCount = 0) {
    const maxRetries = 3;
    
    try {
        const response = await rateLimitedRequest({
            method: 'get',
            url: GAME_API_URL,
            params: {
                gameId: DEFAULT_GAME_ID,
                tableId: DEFAULT_TABLE_ID,
                size: 100,
                curPage: 1
            },
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        
        const newSessions = response.data.data.resultList;
        let updated = false;
        
        for (const session of newSessions) {
            const exists = historicalData.some(h => h.gameNum === session.gameNum);
            if (!exists) {
                historicalData.unshift(session);
                updated = true;
            }
        }
        
        if (historicalData.length > 2000) {
            historicalData = historicalData.slice(0, 2000);
        }
        
        if (updated) {
            saveHistoricalData();
            console.log(`🔄 Đã cập nhật - Tổng: ${historicalData.length}`);
        }
        
        return true;
        
    } catch (error) {
        if (error.response && error.response.status === 429) {
            if (retryCount < maxRetries) {
                const waitTime = (retryCount + 1) * 10000;
                console.log(`⚠️ Bị giới hạn (429), chờ ${waitTime/1000} giây... (lần thử ${retryCount + 1}/${maxRetries})`);
                await delay(waitTime);
                return updateHistoricalData(retryCount + 1);
            } else {
                console.log('❌ Hết số lần thử, bỏ qua cập nhật lần này');
                return false;
            }
        }
        console.error('Lỗi cập nhật:', error.message);
        return false;
    }
}

// Các hàm còn lại giữ nguyên (loadHistoricalData, saveHistoricalData, extractFeatures, LogisticRegression, SimpleRandomForest, trainMLModels, predict functions...)

// API dự đoán với retry
app.get('/api/predict', async (req, res) => {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Cập nhật dữ liệu (nếu cần)
            await updateHistoricalData();
            
            // Gọi API lấy dữ liệu mới nhất
            const response = await rateLimitedRequest({
                method: 'get',
                url: GAME_API_URL,
                params: {
                    gameId: DEFAULT_GAME_ID,
                    tableId: DEFAULT_TABLE_ID,
                    size: 100,
                    curPage: 1
                },
                timeout: 15000
            });
            
            const sessions = response.data.data.resultList;
            const lastSession = sessions[0];
            const currentNum = parseInt(lastSession.gameNum.replace('#', ''));
            const nextSession = currentNum + 1;
            
            // Dự đoán Tài/Xỉu (các hàm dự đoán giữ nguyên)
            const algorithms = [
                predictByFrequency(sessions),
                predictByRecent(sessions),
                predictByWeightedAverage(sessions),
                predictByMarkov(sessions),
                predictByML(sessions, mlModels.logistic),
                predictByML(sessions, mlModels.randomForest)
            ];
            
            const validResults = algorithms.filter(r => r !== null && (r === 'Tài' || r === 'Xỉu'));
            
            let taiVotes = 0, xiuVotes = 0;
            validResults.forEach(r => {
                if (r === 'Tài') taiVotes++;
                else if (r === 'Xỉu') xiuVotes++;
            });
            
            const finalResult = taiVotes >= xiuVotes ? 'Tài' : 'Xỉu';
            const topScores = getTop3Scores(finalResult, sessions);
            
            return res.json({
                Phiên: nextSession,
                dự_đoán: finalResult,
                gợi_ý: topScores.join(',')
            });
            
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.log(`⚠️ API dự đoán bị 429, lần thử ${attempt}/${maxRetries}`);
                if (attempt < maxRetries) {
                    await delay(attempt * 5000);
                    continue;
                }
            }
            
            if (attempt === maxRetries) {
                return res.status(429).json({ 
                    error: 'Server đang quá tải, vui lòng thử lại sau 30 giây',
                    retry_after: 30 
                });
            }
        }
    }
});

// Giảm tần suất tự động cập nhật từ 10s xuống 30s hoặc 60s
setInterval(async () => {
    console.log('🔄 Cập nhật dữ liệu nền...');
    await updateHistoricalData();
    await trainMLModels();
}, 60000); // 60 giây thay vì 10 giây

// Khởi động server
async function startServer() {
    loadHistoricalData();
    await updateHistoricalData();
    await trainMLModels();
    
    app.listen(PORT, () => {
        console.log(`\n✅ API chạy tại http://localhost:${PORT}`);
        console.log(`🔮 Dự đoán: http://localhost:${PORT}/api/predict`);
    });
}

startServer();
