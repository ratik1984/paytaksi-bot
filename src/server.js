import express from "express"
import http from "http"
import { Server } from "socket.io"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: "*",
  },
})

app.use(express.json())
app.use(express.static(path.join(__dirname, "public")))

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id)

  socket.on("driver-online", (data) => {
    socket.broadcast.emit("driver-update", data)
  })

  socket.on("new-order", (order) => {
    socket.broadcast.emit("new-order", order)
  })

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id)
  })
})

app.get("/", (req, res) => {
  res.send("PayTaksi Server Running 🚀")
})

const PORT = process.env.PORT || 10000

server.listen(PORT, () => {
  console.log("Server started on port", PORT)
})
