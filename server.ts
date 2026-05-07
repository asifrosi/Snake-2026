import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Game State
  const rooms = new Map<string, any>();
  let globalHighScore = 0;

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", ({ roomId, player }) => {
      socket.join(roomId);
      
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          players: new Map(),
          foodList: [],
          bossSnake: { x: -100, y: 0, active: false, direction: 'LTR' }
        });
      }

      const room = rooms.get(roomId);
      room.players.set(socket.id, {
        id: socket.id,
        ...player
      });

      // Notify others and send initial state including global high score
      io.to(roomId).emit("room-update", {
        players: Array.from(room.players.values()),
        foodList: room.foodList,
        bossSnake: room.bossSnake,
        globalHighScore
      });
    });

    socket.on("update-state", ({ roomId, player }) => {
      const room = rooms.get(roomId);
      if (room) {
        room.players.set(socket.id, {
          id: socket.id,
          ...player
        });

        // Track global high score
        if (player.score > globalHighScore) {
          globalHighScore = player.score;
          io.emit("high-score-updated", globalHighScore);
        }

        socket.to(roomId).emit("player-updated", {
          id: socket.id,
          ...player
        });
      }
    });

    socket.on("sync-food", ({ roomId, foodList }) => {
      const room = rooms.get(roomId);
      if (room) {
        room.foodList = foodList;
        io.to(roomId).emit("food-updated", foodList);
      }
    });

    socket.on("sync-boss", ({ roomId, bossSnake }) => {
      const room = rooms.get(roomId);
      if (room) {
        room.bossSnake = bossSnake;
        io.to(roomId).emit("boss-updated", bossSnake);
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      rooms.forEach((room, roomId) => {
        if (room.players.has(socket.id)) {
          room.players.delete(socket.id);
          io.to(roomId).emit("player-left", socket.id);
        }
      });
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
