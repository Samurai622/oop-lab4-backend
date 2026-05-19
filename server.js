const express = require('express');
const cors = require('cors');
const { Sequelize, DataTypes } = require('sequelize');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '10kb'}));
app.use(express.static('public'));

// ==========================================
// НОВА СИСТЕМА БЕЗПЕКИ (ТИМЧАСОВИЙ БАН ТА UNLOCK)
// ==========================================
const bannedIps = new Map(); 
const failedAttempts = new Map(); 
const BAN_DURATION_MS = 5 * 60 * 1000; // 5 хвилин

app.use((req, res, next) => {
    const banUntil = bannedIps.get(req.ip);
    if (banUntil) {
        if (Date.now() < banUntil) {
            const timeLeftSec = Math.ceil((banUntil - Date.now()) / 1000);
            return res.status(403).json({ error: `Ваш IP тимчасово заблоковано за підбір пароля!\nЗачекайте ще ${timeLeftSec} секунд.` });
        } else {
            bannedIps.delete(req.ip);
            failedAttempts.delete(req.ip);
        }
    }
    next();
});

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 50, 
    message: { error: "Зафіксовано DDoS атаку!", requirePassword: true }
});

app.post('/api/unlock', (req, res) => {
    const { password } = req.body;
    if (password === 'super-secret-password-123') {
        limiter.resetKey(req.ip);
        failedAttempts.delete(req.ip);
        bannedIps.delete(req.ip); 
        return res.json({ success: true, message: "Розблоковано! Ліміти обнулено." });
    } else {
        let attempts = (failedAttempts.get(req.ip) || 0) + 1;
        failedAttempts.set(req.ip, attempts);
        if (attempts >= 3) {
            bannedIps.set(req.ip, Date.now() + BAN_DURATION_MS);
            return res.status(403).json({ error: "Ви ввели невірний пароль 3 рази.\nВаш IP заблоковано на 5 хвилин!" });
        }
        return res.status(401).json({ error: `Невірний пароль! Залишилось спроб: ${3 - attempts}` });
    }
});

app.use('/api/task1', limiter);
app.use('/api/task2', limiter);

// ==========================================
// ФУНКЦІЯ ДЛЯ ПЕРЕХОПЛЕННЯ ПОМИЛОК ВАЛІДАЦІЇ
// ==========================================
function sendError(res, err) {
    let msg = err.message;
    if (err.name === 'SequelizeValidationError') msg = err.errors.map(e => e.message).join('\n');
    if(err.name === 'SequelizeDatabaseError') msg = "Сервер відхилив запис через помилку в даних.";
    res.status(400).json({ error: msg });
}

const sequelize = new Sequelize({ dialect: 'sqlite', storage: process.env.DB_PATH || './database.sqlite', logging: false });

const Sensor = sequelize.define('Sensor', {
   magnitudeType: { type: DataTypes.INTEGER, allowNull: false },
   minRange: { type: DataTypes.FLOAT, allowNull: false },
   maxRange: { type: DataTypes.FLOAT, allowNull: false, validate: { checkMinMax(value) { if (parseFloat(this.minRange) >= parseFloat(value)) throw new Error("Мінімальна межа має бути строго меншою за максимальну."); } } },
   currentValue: { type: DataTypes.FLOAT, allowNull: false, validate: { checkRange(value) { if (parseFloat(value) < parseFloat(this.minRange) || parseFloat(value) > parseFloat(this.maxRange)) { throw new Error(`Поточне значення має бути в проміжку від ${this.minRange} до ${this.maxRange}.`); } } } }
});

const Device = sequelize.define('Device', {
   locationNumber: { type: DataTypes.INTEGER, allowNull: false, validate: { min: { args: [1], msg: "Номер місця має бути додатнім (більше 0)." } } },
   calibrationDate: { type: DataTypes.DATEONLY, allowNull: false, validate: { notFuture(value) { if (new Date(value) > new Date()) throw new Error("Дата калібрування не може бути в майбутньому."); } } }
});

const Channel = sequelize.define('Channel', {
   name: { type: DataTypes.STRING, allowNull: false, validate: { notEmpty: { msg: "Назва каналу не може бути порожньою." } } }
});

Channel.hasMany(Device, { as: 'devices', onDelete: 'CASCADE' });
Device.belongsTo(Channel);
Device.belongsTo(Sensor);

const Participant = sequelize.define('Participant', {
   firstName: { type: DataTypes.STRING, allowNull: false, validate: { notEmpty: { msg: "Ім'я не може бути порожнім." } } },
   lastName: { type: DataTypes.STRING, allowNull: false, validate: { notEmpty: { msg: "Прізвище не може бути порожнім." } } },
   birthDate: { type: DataTypes.DATEONLY, allowNull: false, validate: { notFuture(value) { if (new Date(value) > new Date()) throw new Error("Дата народження не може бути в майбутньому."); } } }
});

const Performance = sequelize.define('Performance', {
   isTeam: { type: DataTypes.BOOLEAN, allowNull: false },
   resultScore: { type: DataTypes.FLOAT, allowNull: false, validate: { min: { args: [0], msg: "Результат (бали) не може бути від'ємним." } } }
});

const Competition = sequelize.define('Competition', {
   name: { type: DataTypes.STRING, allowNull: false, validate: { notEmpty: { msg: "Назва змагання не може бути порожньою." } } }
});

Competition.hasMany(Performance, { as: 'performances', onDelete: 'CASCADE' });
Performance.belongsTo(Competition);
Performance.belongsTo(Participant);

sequelize.sync({ alter: true }).then(() => console.log("SQLite: Базу даних успішно ініціалізовано у файлі database.sqlite!"));

// ================= TASK 1 =================
app.get('/api/task1/channels', async (req, res) => { try { const channels = await Channel.findAll({ include: [{ model: Device, as: 'devices' }] }); res.json(channels.map(ch => ({ id: ch.id, name: ch.name, devicesCount: ch.devices.length, shortInfo: `Вимірювальний канал №${ch.id} (${ch.name || 'Без назви'})` }))); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/task1/channels/:id', async (req, res) => { try { const channel = await Channel.findByPk(req.params.id, { include: [{ model: Device, as: 'devices', include: [Sensor] }] }); if (!channel) return res.status(404).json({ error: "Канал не знайдено" }); res.json(channel); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/task1/channels', async (req, res) => { try { res.json(await Channel.create(req.body)); } catch (err) { sendError(res, err); } });
app.put('/api/task1/channels/:id', async (req, res) => { try { await Channel.update(req.body, { where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { sendError(res, err); } });
app.delete('/api/task1/channels/:id', async (req, res) => { try { await Channel.destroy({ where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/task1/sensors', async (req, res) => { try { res.json(await Sensor.findAll()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/task1/sensors', async (req, res) => { try { res.json(await Sensor.create(req.body)); } catch (err) { sendError(res, err); } });
app.put('/api/task1/sensors/:id', async (req, res) => { try { await Sensor.update(req.body, { where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { sendError(res, err); } });

app.get('/api/task1/devices', async (req, res) => { try { res.json(await Device.findAll({ include: [Sensor, Channel] })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/task1/devices', async (req, res) => { try { res.json(await Device.create(req.body)); } catch (err) { sendError(res, err); } });
app.put('/api/task1/devices/:id', async (req, res) => { try { await Device.update(req.body, { where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { sendError(res, err); } });
app.delete('/api/task1/devices/:id', async (req, res) => { try { const device = await Device.findByPk(req.params.id); if (device) { await Device.destroy({ where: { id: req.params.id } }); if(device.SensorId) await Sensor.destroy({ where: { id: device.SensorId }}); } res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ================= TASK 2 =================
app.get('/api/task2/competitions', async (req, res) => { try { res.json(await Competition.findAll({ include: [{ model: Performance, as: 'performances', include: [Participant] }] })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/task2/competitions/:id', async (req, res) => { try { const comp = await Competition.findByPk(req.params.id, { include: [{ model: Performance, as: 'performances', include: [Participant] }] }); if (!comp) return res.status(404).json({ error: "Змагання не знайдено" }); res.json(comp); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/task2/competitions', async (req, res) => { try { res.json(await Competition.create(req.body)); } catch (err) { sendError(res, err); } });
app.put('/api/task2/competitions/:id', async (req, res) => { try { await Competition.update(req.body, { where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { sendError(res, err); } });
app.delete('/api/task2/competitions/:id', async (req, res) => { try { const compId = req.params.id; const performances = await Performance.findAll({ where: { CompetitionId: compId } }); for (const perf of performances) { if (perf.ParticipantId) await Participant.destroy({ where: { id: perf.ParticipantId } }); await perf.destroy(); } await Competition.destroy({ where: { id: compId } }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/api/task2/participants', async (req, res) => { try { res.json(await Participant.findAll()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/task2/participants', async (req, res) => { try { res.json(await Participant.create(req.body)); } catch (err) { sendError(res, err); } });
app.put('/api/task2/participants/:id', async (req, res) => { try { await Participant.update(req.body, { where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { sendError(res, err); } });

app.get('/api/task2/performances', async (req, res) => { try { res.json(await Performance.findAll({ include: [Competition, Participant] })); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/api/task2/performances', async (req, res) => { try { res.json(await Performance.create(req.body)); } catch (err) { sendError(res, err); } });
app.put('/api/task2/performances/:id', async (req, res) => { try { await Performance.update(req.body, { where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { sendError(res, err); } });
app.delete('/api/task2/performances/:id', async (req, res) => { try { const perf = await Performance.findByPk(req.params.id); if (perf) { if (perf.ParticipantId) await Participant.destroy({ where: { id: perf.ParticipantId } }); await perf.destroy(); } res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });

app.use((err, req, res, next) => { console.error("Помилка на сервері:", err.message); res.status(500).json({ error: "Внутрішня помилка сервера." }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Node.js Сервер працює!`));