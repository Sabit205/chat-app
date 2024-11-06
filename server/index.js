const express = require('express')
const cors = require('cors')
require('dotenv').config()
const connectDB = require('./config/connectDB')
const router = require('./routes/index')
const cookieParser = require('cookie-parser')
const { initializeSocket } = require('./socket/index')

const app = express()
const http = require('http')
const server = http.createServer(app)

app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}))
app.use(express.json())
app.use(cookieParser())

const PORT = process.env.PORT || 8080

app.get('/', (request, response) => {
    response.json({
        message: "Server running at " + PORT
    })
})

// API endpoints
app.use('/api', router)

// Initialize socket connection
initializeSocket(server)

// Connect to MongoDB and start the server
connectDB().then(() => {
    server.listen(PORT, () => {
        console.log("Server running at " + PORT)
    })
})
