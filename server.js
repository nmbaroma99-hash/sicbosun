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

// File lưu trữ dữ liệu lịch sử
const HISTORY_FILE = 'game_history.json';
let historicalData = [];
let mlModels = { logistic: null, randomForest: null };

// ============ THÊM: XỬ LÝ RATE LIMIT ============
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 5 giây giữa các request

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function rateLimitedRequest(config) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
    }
    lastRequestTime = Date.now();
    return axios(config);
}

// ============ XÁC SUẤT TỔNG ĐIỂM ============
const THEORETICAL_PROBABILITY = {
    4: 1.39, 5: 2.78, 6: 4.63, 7: 6.94, 8: 9.72, 9: 11.57, 10: 12.50,
    11: 12.50, 12: 11.57, 13: 9.72, 14: 6.94, 15: 4.63, 16: 2.78, 17: 1.39
};

function calculateActualProbability(sessions) {
    const scoreCount = {};
    for (let i = 4; i <= 17; i++) scoreCount[i] = 0;
    
    const normalSessions = sessions.filter(s => s.resultType !== 11);
    
    normalSessions.forEach(s => {
        if (s.score >= 4 && s.score <= 17) {
            scoreCount[s.score]++;
        }
    });
    
    const total = normalSessions.length;
    const probability = {};
    for (let i = 4; i <= 17; i++) {
        if (total > 0) {
            probability[i] = (scoreCount[i] / total) * 100;
        } else {
            probability[i] = THEORETICAL_PROBABILITY[i];
        }
    }
    return probability;
}

function calculateRecentTrend(sessions) {
    const recentScores = sessions.slice(0, 10).filter(s => s.resultType !== 11).map(s => s.score);
    const trend = {};
    recentScores.forEach(score => {
        trend[score] = (trend[score] || 0) + 1;
    });
    return trend;
}

function getTop3Scores(prediction, sessions) {
    const actualProb = calculateActualProbability(sessions);
    const recentTrend = calculateRecentTrend(sessions);
    
    let scores = [];
    if (prediction === 'Tài') {
        scores = [11, 12, 13, 14, 15, 16, 17];
    } else {
        scores = [10, 9, 8, 7, 6, 5, 4];
    }
    
    const scoredScores = scores.map(score => {
        const theoretical = THEORETICAL_PROBABILITY[score] / 12.5 * 40;
        const actual = (actualProb[score] / 12.5) * 40;
        let recentBonus = 0;
        if (recentTrend[score]) {
            recentBonus = (recentTrend[score] / 10) * 20;
        }
        const totalScore = theoretical + actual + recentBonus;
        return { score, totalScore };
    });
    
    const sorted = scoredScores.sort((a, b) => b.totalScore - a.totalScore);
    return sorted.slice(0, 3).map(s => s.score);
}

// ============ CÁC HÀM DỮ LIỆU ============
function loadHistoricalData() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            historicalData = JSON.parse(data);
            console.log(`📂 Đã tải ${historicalData.length} phiên lịch sử`);
        }
    } catch (error) {
        historicalData = [];
    }
}

function saveHistoricalData() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(historicalData, null, 2));
    } catch (error) {}
}

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
                console.log(`⚠️ Bị giới hạn (429), chờ ${waitTime/1000} giây... (lần ${retryCount + 1}/${maxRetries})`);
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

// ============ FEATURE ENGINEERING ============
function extractFeatures(sessions, index) {
    if (index < 10) return null;
    
    const prev1 = sessions[index - 1];
    const prev2 = sessions[index - 2];
    const prev3 = sessions[index - 3];
    const prev4 = sessions[index - 4];
    const prev5 = sessions[index - 5];
    
    return {
        features: {
            r1: prev1.resultType === 3 ? 1 : (prev1.resultType === 4 ? 0 : -1),
            r2: prev2.resultType === 3 ? 1 : (prev2.resultType === 4 ? 0 : -1),
            r3: prev3.resultType === 3 ? 1 : (prev3.resultType === 4 ? 0 : -1),
            r4: prev4.resultType === 3 ? 1 : (prev4.resultType === 4 ? 0 : -1),
            r5: prev5.resultType === 3 ? 1 : (prev5.resultType === 4 ? 0 : -1),
            sumScore: prev1.score + prev2.score + prev3.score + prev4.score + prev5.score,
            taiCount: [prev1, prev2, prev3, prev4, prev5].filter(p => p.resultType === 3).length,
            avgScore: (prev1.score + prev2.score + prev3.score + prev4.score + prev5.score) / 5
        },
        label: (sessions[index].resultType === 3) ? 1 : (sessions[index].resultType === 4 ? 0 : null)
    };
}

// ============ LOGISTIC REGRESSION ============
class LogisticRegression {
    constructor() {
        this.weights = null;
        this.featureNames = ['r1', 'r2', 'r3', 'r4', 'r5', 'sumScore', 'taiCount', 'avgScore'];
    }
    
    sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
    
    train(featuresList, labels, learningRate = 0.01, epochs = 300) {
        const numFeatures = this.featureNames.length;
        this.weights = new Array(numFeatures).fill(0);
        
        for (let epoch = 0; epoch < epochs; epoch++) {
            const gradients = new Array(numFeatures).fill(0);
            for (let i = 0; i < featuresList.length; i++) {
                const featureVector = this.featureNames.map(f => featuresList[i][f]);
                let z = 0;
                for (let j = 0; j < numFeatures; j++) z += this.weights[j] * featureVector[j];
                const prediction = this.sigmoid(z);
                const error = prediction - labels[i];
                for (let j = 0; j < numFeatures; j++) gradients[j] += error * featureVector[j];
            }
            for (let j = 0; j < numFeatures; j++) {
                this.weights[j] -= learningRate * gradients[j] / featuresList.length;
            }
        }
    }
    
    predict(features) {
        if (!this.weights) return null;
        const featureVector = this.featureNames.map(f => features[f]);
        let z = 0;
        for (let j = 0; j < this.weights.length; j++) z += this.weights[j] * featureVector[j];
        return this.sigmoid(z) > 0.5 ? 'Tài' : 'Xỉu';
    }
}

// ============ RANDOM FOREST ============
class SimpleRandomForest {
    constructor() { this.trees = []; this.numTrees = 5; }
    
    trainTree(featuresList, labels, indices) {
        const bootstrapFeatures = [], bootstrapLabels = [];
        for (let i of indices) {
            bootstrapFeatures.push(featuresList[i]);
            bootstrapLabels.push(labels[i]);
        }
        const taiCountAvg = bootstrapFeatures.reduce((s, f) => s + f.taiCount, 0) / bootstrapFeatures.length;
        const avgScoreAvg = bootstrapFeatures.reduce((s, f) => s + f.avgScore, 0) / bootstrapFeatures.length;
        return { taiCountAvg, avgScoreAvg };
    }
    
    train(featuresList, labels) {
        this.trees = [];
        for (let t = 0; t < this.numTrees; t++) {
            const indices = [];
            for (let i = 0; i < featuresList.length; i++) {
                indices.push(Math.floor(Math.random() * featuresList.length));
            }
            this.trees.push(this.trainTree(featuresList, labels, indices));
        }
    }
    
    predict(features) {
        if (this.trees.length === 0) return null;
        let taiVotes = 0, xiuVotes = 0;
        for (const tree of this.trees) {
            let prediction = features.taiCount > tree.taiCountAvg ? 'Tài' : 'Xỉu';
            if (prediction === 'Tài') taiVotes++;
            else xiuVotes++;
        }
        return taiVotes > xiuVotes ? 'Tài' : 'Xỉu';
    }
}

// ============ TRAIN ML ============
async function trainMLModels() {
    const trainingData = [];
    for (let i = 10; i < historicalData.length; i++) {
        const result = extractFeatures(historicalData, i);
        if (result && result.label !== null) trainingData.push(result);
    }
    
    if (trainingData.length < 50) return false;
    
    const featuresList = trainingData.map(d => d.features);
    const labels = trainingData.map(d => d.label);
    
    mlModels.logistic = new LogisticRegression();
    mlModels.logistic.train(featuresList, labels);
    
    mlModels.randomForest = new SimpleRandomForest();
    mlModels.randomForest.train(featuresList, labels);
    
    console.log(`✅ ML train xong với ${trainingData.length} mẫu`);
    return true;
}

// ============ 10 THUẬT TOÁN TRUYỀN THỐNG ============

function predictByFrequency(sessions) {
    let tai = 0, xiu = 0;
    for(let i = 0; i < 50; i++) {
        if (sessions[i].resultType === 3) tai++;
        else if (sessions[i].resultType === 4) xiu++;
    }
    return tai > xiu ? 'Tài' : 'Xỉu';
}

function predictByRecent(sessions) {
    let tai = 0, xiu = 0;
    for(let i = 0; i < 10; i++) {
        if (sessions[i].resultType === 3) tai++;
        else if (sessions[i].resultType === 4) xiu++;
    }
    if (tai === xiu) return predictByFrequency(sessions);
    return tai > xiu ? 'Tài' : 'Xỉu';
}

function predictByWeightedAverage(sessions) {
    let weightedSum = 0, totalWeight = 0;
    for(let i = 0; i < 30; i++) {
        const weight = 30 - i;
        weightedSum += sessions[i].score * weight;
        totalWeight += weight;
    }
    const avg = weightedSum / totalWeight;
    return avg > 10.5 ? 'Tài' : 'Xỉu';
}

function predictByMarkov(sessions) {
    const filtered = sessions.filter(s => s.resultType !== 11).slice(0, 60);
    if (filtered.length < 10) return null;
    const last2 = filtered.slice(0, 2).map(s => s.resultType);
    const transition = {};
    for (let i = 0; i < filtered.length - 2; i++) {
        const state = `${filtered[i].resultType}-${filtered[i+1].resultType}`;
        const next = filtered[i+2].resultType;
        if (!transition[state]) transition[state] = { 3: 0, 4: 0 };
        transition[state][next]++;
    }
    const currentState = `${last2[0]}-${last2[1]}`;
    if (transition[currentState]) {
        return transition[currentState][3] > transition[currentState][4] ? 'Tài' : 'Xỉu';
    }
    return null;
}

function predictByDiceFace(sessions) {
    const lastFaces = sessions[0].facesList;
    let sumNext = 0;
    let count = 0;
    
    for(let i = 0; i < 50; i++) {
        if (sessions[i].facesList[0] === lastFaces[0] && 
            sessions[i].facesList[1] === lastFaces[1]) {
            const nextSession = sessions[i+1];
            if (nextSession) {
                sumNext += nextSession.score;
                count++;
            }
        }
    }
    
    if (count > 0) {
        const avg = sumNext / count;
        return avg > 10.5 ? 'Tài' : 'Xỉu';
    }
    return null;
}

function predictByCycle(sessions) {
    const results = sessions.slice(0, 30).map(s => s.resultType === 3 ? 1 : 0);
    let lastChange = 0;
    
    for(let i = 1; i < results.length; i++) {
        if (results[i] !== results[i-1]) {
            lastChange = i;
            break;
        }
    }
    
    if (lastChange > 5) {
        return results[0] === 1 ? 'Xỉu' : 'Tài';
    }
    return null;
}

function predictByNoiseFilter(sessions) {
    const clean = sessions.filter(s => s.resultType !== 11).slice(0, 40);
    let tai = 0, xiu = 0;
    clean.forEach(s => {
        if (s.resultType === 3) tai++;
        else xiu++;
    });
    return tai > xiu ? 'Tài' : 'Xỉu';
}

function predictByReverse(sessions) {
    const last3 = sessions.slice(0, 3).map(s => s.resultType);
    const allSame = last3.every(r => r === last3[0] && r !== 11);
    
    if (allSame) {
        return last3[0] === 3 ? 'Xỉu' : 'Tài';
    }
    return null;
}

function predictByRSI(sessions) {
    let gains = 0, losses = 0;
    
    for(let i = 0; i < 14; i++) {
        const change = sessions[i].score - sessions[i+1].score;
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }
    
    const rs = gains / (losses || 1);
    const rsi = 100 - (100 / (1 + rs));
    
    if (rsi > 70) return 'Xỉu';
    if (rsi < 30) return 'Tài';
    return null;
}

function predictByML(sessions, mlModel) {
    if (!mlModel) return null;
    const features = {
        r1: sessions[0].resultType === 3 ? 1 : (sessions[0].resultType === 4 ? 0 : -1),
        r2: sessions[1].resultType === 3 ? 1 : (sessions[1].resultType === 4 ? 0 : -1),
        r3: sessions[2].resultType === 3 ? 1 : (sessions[2].resultType === 4 ? 0 : -1),
        r4: sessions[3].resultType === 3 ? 1 : (sessions[3].resultType === 4 ? 0 : -1),
        r5: sessions[4].resultType === 3 ? 1 : (sessions[4].resultType === 4 ? 0 : -1),
        sumScore: sessions[0].score + sessions[1].score + sessions[2].score + sessions[3].score + sessions[4].score,
        taiCount: [sessions[0], sessions[1], sessions[2], sessions[3], sessions[4]].filter(s => s.resultType === 3).length,
        avgScore: (sessions[0].score + sessions[1].score + sessions[2].score + sessions[3].score + sessions[4].score) / 5
    };
    return mlModel.predict(features);
}

// ============ API CHÍNH ============

app.get('/api/predict', async (req, res) => {
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await updateHistoricalData();
            
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
            
            // 12 thuật toán dự đoán
            const algorithms = [
                predictByFrequency(sessions),
                predictByRecent(sessions),
                predictByWeightedAverage(sessions),
                predictByMarkov(sessions),
                predictByDiceFace(sessions),
                predictByCycle(sessions),
                predictByNoiseFilter(sessions),
                predictByReverse(sessions),
                predictByRSI(sessions),
                predictByML(sessions, mlModels.logistic),
                predictByML(sessions, mlModels.randomForest)
            ];
            
            const validResults = algorithms.filter(r => r !== null && (r === 'Tài' || r === 'Xỉu'));
            
            let taiVotes = 0, xiuVotes = 0;
            validResults.forEach(r => {
                if (r === 'Tài') taiVotes++;
                else if (r === 'Xỉu') xiuVotes++;
            });
            
            // ML models có trọng số cao hơn
            const mlLogistic = predictByML(sessions, mlModels.logistic);
            const mlForest = predictByML(sessions, mlModels.randomForest);
            if (mlLogistic === 'Tài') taiVotes += 2;
            if (mlLogistic === 'Xỉu') xiuVotes += 2;
            if (mlForest === 'Tài') taiVotes += 2;
            if (mlForest === 'Xỉu') xiuVotes += 2;
            
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

// API lấy 100 phiên
app.get('/api/game-sessions', async (req, res) => {
    try {
        const response = await rateLimitedRequest({
            method: 'get',
            url: GAME_API_URL,
            params: {
                gameId: DEFAULT_GAME_ID,
                tableId: DEFAULT_TABLE_ID,
                size: 100,
                curPage: 1
            }
        });
        
        const sessions = response.data.data.resultList;
        const data = sessions.map(s => ({
            phiên: s.gameNum.replace('#', ''),
            vị: s.keyR,
            kết_quả: s.resultType === 11 ? 'Bão' : (s.resultType === 3 ? 'Tài' : 'Xỉu')
        }));
        res.json({ success: true, total: data.length, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ KHỞI ĐỘNG ============

async function startServer() {
    loadHistoricalData();
    await updateHistoricalData();
    await trainMLModels();
    
    // Giảm tần suất từ 10s xuống 60s để tránh 429
    setInterval(async () => {
        console.log('🔄 Cập nhật dữ liệu nền...');
        const updated = await updateHistoricalData();
        if (updated) await trainMLModels();
    }, 60000); // 60 giây thay vì 10 giây
    
    app.listen(PORT, () => {
        console.log(`\n✅ API chạy tại http://localhost:${PORT}`);
        console.log(`🔮 Dự đoán: http://localhost:${PORT}/api/predict`);
    });
}

startServer();
