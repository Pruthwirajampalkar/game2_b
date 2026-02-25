const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true
    },
    winner: {
        type: String, // username
        required: true
    },
    players: [{
        username: String,
        score: Number
    }],
    date: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Match', matchSchema);
