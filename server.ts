import Bun from 'bun';

interface Room {
  name: string;
  lock?: string;
}

interface User {
  id: number;
  name: string;
  online: boolean;
  room: string;
}

interface ConnectionData {
  connectionStart: number;
  userId: number;
}

enum WsActions {
  // sys actions
  unknown = "unknown",
  confirmation = "confirmation",
  // user actions
  register = "register",
  chat = "chat",
  createRoom = "createRoom",
  joinRoom = "join",
  leaveRoom = "leave",
  fetchRooms = "fetchRooms",
  fetchUsers = "fetchUsers",
}

type MessageData = string | Array<string|User> | Buffer<ArrayBufferLike> | undefined;
interface WsMessage {
  action: WsActions;
  meta?: string | number;
  msg?: MessageData;
}

// global variables
let uId: number = 1;
let roomCache: Room[] = [{ name: "Ming" }];
let userCache: User[] = [];
const CLEAN_UP_INTERVAL = 300000; // 5 mins
const PORT = Bun.env.PORT || 3000;

// WS actions
function userId(): number {
  const id = uId;
  uId++;
  return id;
}

function registerUser(userId: number, msg: WsMessage) {
  const newUser: User = {
    id: userId,
    name: msg.meta as string,
    online: true,
    room: "",
  };
  userCache.push(newUser);
}

function createRoom(msg: WsMessage): boolean {
  if (!msg.msg || typeof msg.msg !== "string") return false;
  const name = msg.msg;
  const lock = msg.meta as string | undefined;
  roomCache.push({ name, lock });
  console.log("Created new room: ", name);
  return true;
}

function joinRoom(server: Bun.Server, ws: Bun.ServerWebSocket<unknown>, userId: number, room: MessageData): boolean {
  const [existingRoom] = roomCache.filter(rm => rm.name === room);
  const [user] = userCache.filter(usr => usr.id === userId);
  if (!existingRoom || !user) return false;
  user.room = existingRoom.name;
  const roomName = room as string;
  server.publish(room as string, JSON.stringify({
    action: WsActions.fetchUsers,
    msg: userCache.filter(user => user.room === roomName),
  }));
  ws.subscribe(roomName);
  return true;
}

function sendMessage(server: Bun.Server, userId: number, msg: WsMessage): boolean {
  const [user] = userCache.filter(usr => usr.id === userId);
  if (!user || !msg.msg || typeof msg.msg !== "string") return false;
  server.publish(user.room, JSON.stringify({
    action: WsActions.chat,
    msg: [user.name, msg.msg]
  }));
  return true;
}

function leaveRoom(ws: Bun.ServerWebSocket<unknown>, userId: number, room: MessageData): boolean {
  const [existingRoom] = roomCache.filter(rm => rm.name === room);
  const [user] = userCache.filter(usr => usr.id === userId);
  if (!existingRoom || !user) return false;
  ws.unsubscribe(room as string);
  return true;
}

// periodically clean out offline users/empty rooms
setInterval(() => {
  const activeRooms: Map<string, number> = new Map;
  userCache = userCache.filter(user => {
    if (user.room !== "") {
      const cur = activeRooms.get(user.room);
      if (!cur) activeRooms.set(user.room, 1);
      else activeRooms.set(user.room, cur + 1);
    }
    return user.online === true;
  });
  console.log("Active rooms:", activeRooms);
  roomCache = roomCache.filter(room => room.name === "Ming" || activeRooms.has(room.name));
}, CLEAN_UP_INTERVAL);

// server setup
const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const success = server.upgrade(req, {
      data: {
        connectionStart: Date.now(),
        userId: userId()
      }
    });
    if (!success) {
      return new Response("Upgrade Failed", { status: 500 });
    }
  },
  websocket: {
    message(ws, message) {
      const connData = ws.data as ConnectionData;
      let returnMsg = true;
      let retMsg: WsMessage = {
        action: WsActions.unknown,
      };
      if (typeof message === "string") {
        const wsMsg = JSON.parse(message) as WsMessage;
        retMsg.action = wsMsg.action;
        switch (wsMsg.action) {
          case WsActions.register:
            registerUser(connData.userId, wsMsg);
            retMsg.msg = "Registered";
            break;
          case WsActions.chat:
            if (!sendMessage(server, connData.userId, wsMsg)) {
              retMsg.action = WsActions.confirmation;
              retMsg.msg = "Failed to send message";
            } else {
              returnMsg = false;
            }
            break;
          case WsActions.createRoom:
            if (createRoom(wsMsg)) retMsg.msg = "Success";
            else retMsg.msg = "Failed";
            break;
          case WsActions.joinRoom:
            if (joinRoom(server, ws, connData.userId, wsMsg.msg)) {
              retMsg.msg = "Success";
              if (typeof wsMsg.msg === "string") retMsg.meta = wsMsg.msg;
            }
            else retMsg.msg = "failed";
            break;
          case WsActions.leaveRoom:
            if (leaveRoom(ws, connData.userId, wsMsg.msg)) retMsg.msg = "Success";
            else retMsg.msg = "failed";
            break;
          case WsActions.fetchRooms:
            retMsg.msg = roomCache.map(room => room.name);
            break;
          case WsActions.fetchUsers:
            const roomFilter = wsMsg.msg as string;
            retMsg.msg = userCache.filter(user => user.room === roomFilter);
            break;
          default:
            retMsg.msg = "Unrecognized message from user";
            break;
        }
      } else {
        retMsg.msg = "Unrecognized message from user";
      }
      if (returnMsg) ws.send(JSON.stringify(retMsg));
    },
    open(ws) {
      const data = ws.data as ConnectionData;
      console.log(`Connection established (${data.userId})`);
      ws.send(JSON.stringify({
        action: WsActions.confirmation,
        msg: "Connected user " + data.userId,
      }));
    },
    close(ws, _code, _message) {
      const data = ws.data as ConnectionData;
      console.log(`Connection ended (${data.userId})`);
      let room = "";
      // update user cache
      userCache.forEach(user => {
        if (user.id === data.userId) {
          room = user.room;
          user.online = false;
        }
      });
      // send msg to room
      if (room) {
        server.publish(room, JSON.stringify({
          action: WsActions.fetchUsers,
          msg: userCache.filter(user => user.room === room),
        }));
      }
    },
  }
});

console.log(`Started server on ${server.hostname}:${server.port}`);