const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL,
    credentials: true,
  },
});

// Online user set (consider Redis for production environments)
const onlineUsers = new Set();

io.on('connection', async (socket) => {
  console.log('User connected: ', socket.id);

  // Ensure token exists and user is authenticated
  const token = socket.handshake.auth?.token;
  if (!token) {
    console.log('No token provided, disconnecting user');
    socket.disconnect(true);
    return;
  }

  try {
    const user = await getUserDetailsFromToken(token);
    if (!user) {
      console.log('Invalid token, disconnecting user');
      socket.disconnect(true);
      return;
    }

    // Add user to room and online users set
    const userId = user._id.toString();
    socket.join(userId);
    onlineUsers.add(userId);

    // Emit online users
    io.emit('onlineUser', Array.from(onlineUsers));

    // Handle "message-page" event
    socket.on('message-page', async (targetUserId) => {
      try {
        const targetUser = await UserModel.findById(targetUserId).select('-password');
        if (!targetUser) return;

        const payload = {
          _id: targetUser._id,
          name: targetUser.name,
          email: targetUser.email,
          profile_pic: targetUser.profile_pic,
          online: onlineUsers.has(targetUserId),
        };
        socket.emit('message-user', payload);

        const conversation = await ConversationModel.findOne({
          $or: [
            { sender: userId, receiver: targetUserId },
            { sender: targetUserId, receiver: userId },
          ],
        })
          .populate('messages')
          .sort({ updatedAt: -1 });

        socket.emit('message', conversation?.messages || []);
      } catch (error) {
        console.error('Error in "message-page" event:', error);
      }
    });

    // Handle "new message" event
    socket.on('new message', async (data) => {
      try {
        let conversation = await ConversationModel.findOne({
          $or: [
            { sender: data.sender, receiver: data.receiver },
            { sender: data.receiver, receiver: data.sender },
          ],
        });

        // If conversation doesn't exist, create a new one
        if (!conversation) {
          const newConversation = new ConversationModel({
            sender: data.sender,
            receiver: data.receiver,
          });
          conversation = await newConversation.save();
        }

        const message = new MessageModel({
          text: data.text,
          imageUrl: data.imageUrl,
          videoUrl: data.videoUrl,
          msgByUserId: data.msgByUserId,
        });
        await message.save();

        await ConversationModel.findByIdAndUpdate(conversation._id, {
          $push: { messages: message._id },
        });

        const updatedConversation = await ConversationModel.findById(conversation._id)
          .populate('messages')
          .sort({ updatedAt: -1 });

        // Emit messages to both sender and receiver
        io.to(data.sender).emit('message', updatedConversation?.messages || []);
        io.to(data.receiver).emit('message', updatedConversation?.messages || []);

        // Send updated conversation to sender and receiver
        const senderConversations = await getConversation(data.sender);
        const receiverConversations = await getConversation(data.receiver);

        io.to(data.sender).emit('conversation', senderConversations);
        io.to(data.receiver).emit('conversation', receiverConversations);
      } catch (error) {
        console.error('Error in "new message" event:', error);
      }
    });

    // Handle "sidebar" event
    socket.on('sidebar', async (currentUserId) => {
      try {
        const conversations = await getConversation(currentUserId);
        socket.emit('conversation', conversations);
      } catch (error) {
        console.error('Error in "sidebar" event:', error);
      }
    });

    // Handle "seen" event (when a user marks messages as seen)
    socket.on('seen', async (targetUserId) => {
      try {
        const conversation = await ConversationModel.findOne({
          $or: [
            { sender: userId, receiver: targetUserId },
            { sender: targetUserId, receiver: userId },
          ],
        });

        const messageIds = conversation?.messages || [];
        await MessageModel.updateMany(
          { _id: { $in: messageIds }, msgByUserId: targetUserId },
          { $set: { seen: true } }
        );

        const senderConversations = await getConversation(userId);
        const receiverConversations = await getConversation(targetUserId);

        io.to(userId).emit('conversation', senderConversations);
        io.to(targetUserId).emit('conversation', receiverConversations);
      } catch (error) {
        console.error('Error in "seen" event:', error);
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      onlineUsers.delete(userId);
      console.log('User disconnected:', socket.id);
      io.emit('onlineUser', Array.from(onlineUsers));
    });
  } catch (error) {
    console.error('Connection error:', error);
    socket.disconnect(true);
  }
});

module.exports = {
  app,
  server,
};
