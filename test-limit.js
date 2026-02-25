const { io } = require("socket.io-client");

async function test() {
    console.log("Starting test...");
    const roomId = "TEST99";
    const sockets = [];

    // Connect 8 users successfully
    for (let i = 1; i <= 8; i++) {
        const socket = io("http://localhost:3001");
        sockets.push(socket);

        await new Promise(resolve => {
            socket.on("connect", () => {
                socket.emit("join_room", { username: `User${i}`, roomId });
                resolve();
            });
        });

        await new Promise(resolve => setTimeout(resolve, 50)); // small delay
    }

    console.log("8 users connected.");

    // Attempt 9th user
    const socket9 = io("http://localhost:3001");
    socket9.on("connect", () => {
        socket9.emit("join_room", { username: "User9", roomId });
    });

    socket9.on("room_error", (msg) => {
        console.log("Received expected error for 9th user:", msg);

        // Clean up
        sockets.forEach(s => s.disconnect());
        socket9.disconnect();
        process.exit(0);
    });

    socket9.on("room_update", () => {
        console.error("FAIL: 9th user joined successfully!");
        process.exit(1);
    });
}

test().catch(console.error);
