// src/socketHandlers/chatHandlers.jsx
import mongoose from 'mongoose';
import moment from 'moment';
import { isRealString } from '../utils/validation';
import Message from '../models/Message';
import TribeMessage from '../models/TribeMessage';
import Notification from '../models/notifications';
import User from '../models/user';
import MyTribe from '../models/mytribes.js';
import ChatLobby from '../models/chatlobby';
import TribeChatLobby from '../models/tribechatlobby';
import { users } from './usersInstance';
import redis from '../clients/redis.js';

const BUFFER_BATCH_SIZE = 10;

/**
 * Flush buffered chat messages for a room into MongoDB in bulk.
 */
async function flushChatBuffer(room) {
  const key = `chat:buffer:${room}`;
  const items = await redis.lrange(key, 0, -1);
  if (!items.length) return;

  const docs = items.map((raw) => {
    const p = JSON.parse(raw);
    return {
      chatLobbyId: room,
      sender:      new mongoose.Types.ObjectId(p.senderId),
      message:     p.text,
      type:        'text',
      seen:        false,
      sentAt:      new Date(p.timestamp),
    };
  });

  try {
    await Message.insertMany(docs);
    // clear deletefor once per batch
    await ChatLobby.findOneAndUpdate(
      { chatLobbyId: room },
      { $set: { deletefor: [] } }
    );
  } catch (err) {
    console.error('Error bulk‐inserting chat buffer for room', room, err);
    // leave the buffer intact for retry
    return;
  }

  await redis.del(key);
}

/**
 * Flush buffered tribe messages for a room into MongoDB in bulk.
 */
async function flushTribeBuffer(room) {
  const key = `tribe:buffer:${room}`;
  const items = await redis.lrange(key, 0, -1);
  if (!items.length) return;

  const docs = items.map((raw) => {
    const p = JSON.parse(raw);
    return {
      chatLobbyId: room,
      sender:      new mongoose.Types.ObjectId(p.senderId),
      message:     p.text,
      type:        'text',
      seen:        false,
      sentAt:      new Date(p.timestamp),
    };
  });

  try {
    await TribeMessage.insertMany(docs);
    await TribeChatLobby.findOneAndUpdate(
      { chatLobbyId: room },
      { $set: { deletefor: [] } }
    );
  } catch (err) {
    console.error('Error bulk‐inserting tribe buffer for room', room, err);
    return;
  }

  await redis.del(key);
}

export const registerChatHandlers = (socket, io) => {
  // — join a room —
  socket.on('join', (params, callback) => {
    if (
      !isRealString(params.name) ||
      !isRealString(params.room) ||
      !isRealString(params.userId)
    ) {
      return callback('Name, room, and userId are required.');
    }
    socket.join(params.room);
    users.removeUser(socket.id);
    users.addUser(socket.id, params.name, params.room, params.userId);
    io.to(params.room).emit('updateUserList', users.getUserList(params.room));
    callback();
  });

  // — normal chat messages —
  socket.on('createMessage', async (message, callback) => {
    const user = users.getUser(socket.id);
    if (!(user && isRealString(message.text))) {
      console.error('Invalid user or empty message');
      return callback();
    }

    // 1️⃣ Buffer in Redis
    const tempKey = `chat:buffer:${user.room}`;
    const buf = {
      senderId:  user.userId,
      senderName: user.name,
      text:      message.text,
      timestamp: Date.now(),
    };
    await redis.rpush(tempKey, JSON.stringify(buf));
    await redis.expire(tempKey, 3600);

    // 2️⃣ Immediate broadcast & notifications
 // include both senderId & room so clients know which lobby to update
  io.to(user.room).emit('newMessage', {
    _id:        null,
    text:       message.text,
   from:       user.name,
   sentAt:     new Date(buf.timestamp),
    seen:       false,
    type:       'text',
    senderId:   user.userId,
    chatLobbyId: user.room,
  });


    // clear deletefor
    ChatLobby.findOneAndUpdate(
         { chatLobbyId: user.room },
          { 
            $set: { 
              deletefor:   [], 
              lastmsg:      message.text, 
             lastUpdated:  new Date(),
           }
     },
          { new: true }    // return the updated document
       )
        .then((updatedLobby) => {
          // emit a lobbyUpdated event so all clients can re-sort their lists
      io.emit('lobbyUpdated', {
            chatLobbyId: updatedLobby.chatLobbyId,
            lastmsg:     updatedLobby.lastmsg,
            lastUpdated: updatedLobby.lastUpdated,
          });
        })
        .catch(console.error);

    // send notifications
    ChatLobby.findOne({ chatLobbyId: user.room })
      .then((lobby) => {
        if (!lobby?.participants) return;
        lobby.participants.forEach(async (participant) => {
          if (participant.toString() === user.userId) return;
          const other = await User.findById(participant);
          if (!other) return;
          await Notification.updateOne(
            { user: participant },
            { $addToSet: { type: 'message', data: `New message from ${user.name}` } },
            { upsert: true }
          );
        });
      })
      .catch(console.error);

    // 3️⃣ Conditional bulk‐flush
    const len = await redis.llen(tempKey);
    if (len >= BUFFER_BATCH_SIZE) {
      await flushChatBuffer(user.room);
    }

    callback();
  });

  socket.on('tribeCreateMessage', async (data, callback) => {
    try {
      const user = users.getUser(socket.id);
      if (!user || !isRealString(data.text)) {
        return callback('Invalid message');
      }

      // 1) Save to MongoDB
      const newMsg = await TribeMessage.create({
        chatLobbyId: user.room,
        sender:      user.userId,
        message:     data.text,
        type:        'text',
        seen:        false,
        senderUsername: user.name,
        sentAt:      new Date(),
      });

      // 2) Broadcast to everyone with real IDs
      io.to(user.room).emit('newTribeMessage', {
        _id:       newMsg._id.toString(),
        text:      newMsg.message,
        from:      user.name,
        senderUsername:  newMsg.senderUsername,
        senderId:  user.userId,
        sentAt:    newMsg.sentAt,
        seen:      newMsg.seen,
        type:      newMsg.type,
      });

      // 3) (Optional) clear any "deletefor" flags
      await TribeChatLobby.findOneAndUpdate(
        { chatLobbyId: user.room },
        { $set: { deletefor: [] } }
      );

      // 4) Notify other participants
      const lobby = await TribeChatLobby.findOne({ chatLobbyId: user.room });
      if (lobby?.participants) {
        for (const p of lobby.participants) {
          if (p.toString() === user.userId) continue;
          await Notification.updateOne(
            { user: p },
            { $addToSet: { type: 'message', data: `New tribe message from ${user.name}` } },
            { upsert: true }
          );
        }
      }

      callback(null, newMsg);
    } catch (err) {
      console.error('tribeCreateMessage error:', err);
      callback('Server error');
    }
  });

  // — on disconnect: flush any remaining buffers —
  socket.on('disconnect', async () => {
    const user = users.getUser(socket.id);
    if (user) {
      await flushChatBuffer(user.room);
      await flushTribeBuffer(user.room);
      users.removeUser(socket.id);
      io.to(user.room).emit('updateUserList', users.getUserList(user.room));
    }
  });

  // — rest of your handlers unchanged —
  socket.on("messageSeen", async ({ messageId, room, readerId }) => {
    try {
      let updatedMessage;
  
      if (messageId) {
        // normal path: client told us the exact message _id
        updatedMessage = await Message.findByIdAndUpdate(
          messageId,
          { seen: true },
          { new: true }
        );
      } else {
        // fallback: mark the most‐recent unseen message in that lobby
        updatedMessage = await Message.findOneAndUpdate(
          { chatLobbyId: room, seen: false },
          { seen: true },
          { sort: { sentAt: -1 }, new: true }
        );
      }
  
      if (!updatedMessage) return;
  
      // broadcast back to everyone in the room (including the sender)
      io.to(room).emit("messageUpdated", {
        _id:        updatedMessage._id,
        chatLobbyId: room,
        seen:       true,
      });
    } catch (err) {
      console.error("Error marking message seen:", err);
    }
  });
  
  

  // New deleteMessage event handler
  socket.on('deleteMessage', async (data, callback) => {
    try {
      const user = data.userId;
      const tempKey = `chat:buffer:${data.chatLobbyId}`;
      const bufferItems = await redis.lrange(tempKey, 0, -1);
      const dataTimestamp = new Date(data.time).getTime();
  
      let foundInRedis = false;
      for (const item of bufferItems) {
        const msg = JSON.parse(item);
        if (msg.timestamp === dataTimestamp && msg.senderId === user) {
          await redis.lrem(tempKey, 1, item);
          io.to(data.room).emit('messageDeleted', { messageId: null, timestamp: msg.timestamp });
          foundInRedis = true;
          break;
        }
      }
      if (foundInRedis) return callback(null, "Message deleted from buffer");
  
      const msg = await Message.findById(data.messageId);
      if (!msg) return callback("Message not found");
  
      if (data.deleteType === "forEveryone") {
        const messageAge = moment().diff(moment(msg.sentAt), "minutes");
        if (messageAge >= 7) return callback("Deletion time window expired");
      }
  
      if (msg.type === "file" && msg.fileUrl && data.deleteType === "forEveryone") {
        try {
          const urlObj = new URL(msg.fileUrl);
          const encodedFileName = urlObj.pathname.split('/o/')[1];
          const fileName = decodeURIComponent(encodedFileName.split('?')[0]);
          await bucket.file(fileName).delete();
        } catch (fileDelErr) {
          console.error("Error deleting file from Firebase:", fileDelErr);
        }
      }
  
      await Message.findByIdAndDelete(data.messageId);
      io.to(msg.chatLobbyId).emit('messageDeleted', { messageId: data.messageId });
      callback(null, "Message deleted");
    } catch (err) {
      console.error("Error deleting message:", err);
      callback("Error deleting message");
    }
  });
  


  // — DELETE tribe message —
  socket.on('deleteTribeMessage', async (data, callback) => {
    try {
      const { room, userId, messageId, deleteType } = data;
      const user = users.getUser(socket.id);
      if (!user) return callback('Not authorized');

      // 1) Check admin status
      const tribe = await MyTribe.findOne({ chatLobbyId: room }).select('admins');
      const isAdmin = tribe?.admins
        .map((id) => id.toString())
        .includes(user.userId);

      // 2) Load from DB
      const msg = await TribeMessage.findById(messageId);
      if (!msg) return callback('Message not found');

      // 3) Enforce 7-minute window for non-admins
      if (!isAdmin && deleteType === 'forEveryone') {
        const ageMin = moment().diff(moment(msg.sentAt), 'minutes');
        if (ageMin >= 7) return callback('Deletion window expired');
      }

      // 4) (Optional) delete file from storage if msg.type === 'file'

      // 5) Remove and broadcast
      await msg.deleteOne();
      io.to(room).emit('messageDeleted', { messageId });

      callback(null, 'Deleted');
    } catch (err) {
      console.error('deleteTribeMessage error:', err);
      callback('Server error');
    }
  });
};