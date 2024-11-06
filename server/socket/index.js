const { Server } = require('socket.io');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');

// Online users tracking set
const onlineUser = new Set();

// Initialize socket server function
function initializeSocket(server) {
    const io = new Server(server, {
        cors: {
            origin: process.env.FRONTEND_URL,
            credentials: true
        }
    });

    io.on('connection', async (socket) => {
        console.log("Connected user with socket ID:", socket.id);

        const token = socket.handshake.auth.token;
        console.log('Received token:', token); // Log received token

        try {
            // Retrieve current user details
            const user = await getUserDetailsFromToken(token);

            if (user && user._id) {
                console.log("Authenticated user:", user._id);
                socket.join(user._id.toString());
                onlineUser.add(user._id.toString());

                io.emit('onlineUser', Array.from(onlineUser));
            } else {
                console.warn("Invalid token or user not found. Disconnecting socket.");
                socket.disconnect(); // Disconnect if the user is not authenticated
                return;
            }
        } catch (error) {
            console.error("Error in token validation:", error);
            socket.disconnect();
            return;
        }

        // Handle message-page event
        socket.on('message-page', async (userId) => {
            console.log('Fetching user details for userId:', userId);
            try {
                const userDetails = await UserModel.findById(userId).select("-password");
                
                const payload = {
                    _id: userDetails?._id,
                    name: userDetails?.name,
                    email: userDetails?.email,
                    profile_pic: userDetails?.profile_pic,
                    online: onlineUser.has(userId)
                };
                socket.emit('message-user', payload);

                // Get previous messages
                const getConversationMessage = await ConversationModel.findOne({
                    "$or": [
                        { sender: user._id, receiver: userId },
                        { sender: userId, receiver: user._id }
                    ]
                }).populate('messages').sort({ updatedAt: -1 });

                socket.emit('message', getConversationMessage?.messages || []);
            } catch (error) {
                console.error("Error fetching user or conversation details:", error);
            }
        });

        // Handle new message event
        socket.on('new message', async (data) => {
            console.log('New message received:', data);
            try {
                // Check if a conversation exists between both users
                let conversation = await ConversationModel.findOne({
                    "$or": [
                        { sender: data?.sender, receiver: data?.receiver },
                        { sender: data?.receiver, receiver: data?.sender }
                    ]
                });

                // If conversation does not exist, create a new one
                if (!conversation) {
                    const createConversation = new ConversationModel({
                        sender: data?.sender,
                        receiver: data?.receiver
                    });
                    conversation = await createConversation.save();
                }

                const message = new MessageModel({
                    text: data.text,
                    imageUrl: data.imageUrl,
                    videoUrl: data.videoUrl,
                    msgByUserId: data?.msgByUserId,
                });
                const saveMessage = await message.save();

                await ConversationModel.updateOne({ _id: conversation._id }, {
                    "$push": { messages: saveMessage._id }
                });

                const getConversationMessage = await ConversationModel.findOne({
                    "$or": [
                        { sender: data?.sender, receiver: data?.receiver },
                        { sender: data?.receiver, receiver: data?.sender }
                    ]
                }).populate('messages').sort({ updatedAt: -1 });

                io.to(data?.sender).emit('message', getConversationMessage?.messages || []);
                io.to(data?.receiver).emit('message', getConversationMessage?.messages || []);

                // Send updated conversation to both users
                const conversationSender = await getConversation(data?.sender);
                const conversationReceiver = await getConversation(data?.receiver);

                io.to(data?.sender).emit('conversation', conversationSender);
                io.to(data?.receiver).emit('conversation', conversationReceiver);
            } catch (error) {
                console.error("Error handling new message:", error);
            }
        });

        // Handle sidebar event
        socket.on('sidebar', async (currentUserId) => {
            console.log("Fetching sidebar conversation for user:", currentUserId);
            try {
                const conversation = await getConversation(currentUserId);
                socket.emit('conversation', conversation);
            } catch (error) {
                console.error("Error fetching sidebar conversation:", error);
            }
        });

        // Handle seen event
        socket.on('seen', async (msgByUserId) => {
            console.log("Marking messages as seen for conversation with user:", msgByUserId);
            try {
                const conversation = await ConversationModel.findOne({
                    "$or": [
                        { sender: user._id, receiver: msgByUserId },
                        { sender: msgByUserId, receiver: user._id }
                    ]
                });

                const conversationMessageId = conversation?.messages || [];

                await MessageModel.updateMany(
                    { _id: { "$in": conversationMessageId }, msgByUserId: msgByUserId },
                    { "$set": { seen: true } }
                );

                // Send updated conversation status
                const conversationSender = await getConversation(user._id.toString());
                const conversationReceiver = await getConversation(msgByUserId);

                io.to(user._id.toString()).emit('conversation', conversationSender);
                io.to(msgByUserId).emit('conversation', conversationReceiver);
            } catch (error) {
                console.error("Error marking messages as seen:", error);
            }
        });

        // Handle disconnect
        socket.on('disconnect', () => {
            onlineUser.delete(user._id.toString());
            console.log('Disconnected user', socket.id);
        });
    });
}

module.exports = {
    initializeSocket
};
