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

type MessageData = string | Array<string> | Array<number> | Buffer<ArrayBufferLike> | undefined;
interface WsMessage {
  action: WsActions;
  meta?: string | number;
  msg?: MessageData;
}

// global variables
let uId: number = 1;
const roomCache: Room[] = [{ name: "global" }];
let userCache: User[] = [];

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
    room: "-",
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

function joinRoom(ws: Bun.ServerWebSocket<unknown>, userId: number, room: MessageData): boolean {
  const [existingRoom] = roomCache.filter(rm => rm.name === room);
  const [user] = userCache.filter(usr => usr.id === userId);
  if (!existingRoom || !user) return false;
  user.room = existingRoom.name;
  ws.subscribe(room as string);
  return true;
}

function sendMessage(server: Bun.Server, msg: WsMessage): boolean {
  if (!msg.meta || !msg.msg) return false;
  if (typeof msg.msg !== "string") return false;
  server.publish(msg.meta as string, msg.msg);
  return true;
}

function leaveRoom(ws: Bun.ServerWebSocket<unknown>, userId: number, room: MessageData): boolean {
  const [existingRoom] = roomCache.filter(rm => rm.name === room);
  const [user] = userCache.filter(usr => usr.id === userId);
  if (!existingRoom || !user) return false;
  ws.unsubscribe(room as string);
  return true;
}

// server setup
const server = Bun.serve({
  port: 3000,
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
      let returnMsg = false;
      let retMsg: WsMessage = {
        action: WsActions.unknown,
      };
      if (typeof message === "string") {
        retMsg.action = WsActions.confirmation;
        const wsMsg = JSON.parse(message) as WsMessage;
        switch (wsMsg.action) {
          case WsActions.register:
            registerUser(connData.userId, wsMsg);
            retMsg.msg = "Registered";
            break;
          case WsActions.chat:
            if (!sendMessage(server, wsMsg)) retMsg.msg = "Failed to send message";
            break;
          case WsActions.createRoom:
            returnMsg = true;
            if (createRoom(wsMsg)) retMsg.msg = "Success";
            else retMsg.msg = "Failed";
            break;
          case WsActions.joinRoom:
            returnMsg = true;
            if (joinRoom(ws, connData.userId, wsMsg.msg)) retMsg.msg = "Success";
            else retMsg.msg = "failed";
            break;
          case WsActions.leaveRoom:
            returnMsg = true;
            if (leaveRoom(ws, connData.userId, wsMsg.msg)) retMsg.msg = "Success";
            else retMsg.msg = "failed";
            break;
          case WsActions.fetchRooms:
            returnMsg = true;
            retMsg.action = WsActions.fetchRooms;
            retMsg.msg = roomCache.map(room => room.name);
            break;
          default:
            returnMsg = true;
            retMsg.msg = "Unrecognized message from user";
            break;
        }
      } else {
        returnMsg = true;
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
      userCache = userCache.filter(usr => usr.id !== data.userId);
    },
  }
});

console.log(`Started server on ${server.hostname}:${server.port}`);