import socketIO = require('socket.io');
import {Socket} from "socket.io";
import * as http from "http";
import {MessageUserPosition, Point} from "../Model/Websocket/MessageUserPosition"; //TODO fix import by "_Model/.."
import {ExSocketInterface} from "../Model/Websocket/ExSocketInterface"; //TODO fix import by "_Model/.."
import Jwt, {JsonWebTokenError} from "jsonwebtoken";
import {SECRET_KEY, MINIMUM_DISTANCE, GROUP_RADIUS, ALLOW_ARTILLERY} from "../Enum/EnvironmentVariable"; //TODO fix import by "_Enum/..."
import {World} from "../Model/World";
import {Group} from "../Model/Group";
import {User} from "../Model/User";
import {isSetPlayerDetailsMessage,} from "../Model/Websocket/SetPlayerDetailsMessage";
import {MessageUserJoined} from "../Model/Websocket/MessageUserJoined";
import {MessageUserMoved} from "../Model/Websocket/MessageUserMoved";
import si from "systeminformation";
import {Gauge} from "prom-client";
import {TokenInterface} from "../Controller/AuthenticateController";
import {isJoinRoomMessageInterface} from "../Model/Websocket/JoinRoomMessage";
import {isPointInterface, PointInterface} from "../Model/Websocket/PointInterface";
import {isWebRtcSignalMessageInterface} from "../Model/Websocket/WebRtcSignalMessage";
import {UserInGroupInterface} from "../Model/Websocket/UserInGroupInterface";
import {isItemEventMessageInterface} from "../Model/Websocket/ItemEventMessage";
import {uuid} from 'uuidv4';
import {isUserMovesInterface} from "../Model/Websocket/UserMovesMessage";
import {isViewport} from "../Model/Websocket/ViewportMessage";
import {GroupUpdateInterface} from "_Model/Websocket/GroupUpdateInterface";
import {Movable} from "../Model/Movable";

enum SockerIoEvent {
    CONNECTION = "connection",
    DISCONNECT = "disconnect",
    JOIN_ROOM = "join-room", // bi-directional
    USER_POSITION = "user-position", // From client to server
    USER_MOVED = "user-moved", // From server to client
    USER_LEFT = "user-left", // From server to client
    WEBRTC_SIGNAL = "webrtc-signal",
    WEBRTC_SCREEN_SHARING_SIGNAL = "webrtc-screen-sharing-signal",
    WEBRTC_START = "webrtc-start",
    WEBRTC_DISCONNECT = "webrtc-disconect",
    MESSAGE_ERROR = "message-error",
    GROUP_CREATE_UPDATE = "group-create-update",
    GROUP_DELETE = "group-delete",
    SET_PLAYER_DETAILS = "set-player-details",
    ITEM_EVENT = 'item-event',
    SET_SILENT = "set_silent", // Set or unset the silent mode for this user.
    SET_VIEWPORT = "set-viewport",
    BATCH = "batch",
}

function emitInBatch(socket: ExSocketInterface, event: string | symbol, payload: unknown): void {
    socket.batchedMessages.push({ event, payload});

    if (socket.batchTimeout === null) {
        socket.batchTimeout = setTimeout(() => {
            socket.emit(SockerIoEvent.BATCH, socket.batchedMessages);
            socket.batchedMessages = [];
            socket.batchTimeout = null;
        }, 100);
    }
}

export class IoSocketController {
    public readonly Io: socketIO.Server;
    private Worlds: Map<string, World> = new Map<string, World>();
    private sockets: Map<string, ExSocketInterface> = new Map<string, ExSocketInterface>();
    private nbClientsGauge: Gauge<string>;
    private nbClientsPerRoomGauge: Gauge<string>;

    constructor(server: http.Server) {
        this.Io = socketIO(server);
        this.nbClientsGauge = new Gauge({
            name: 'workadventure_nb_sockets',
            help: 'Number of connected sockets',
            labelNames: [ ]
        });
        this.nbClientsPerRoomGauge = new Gauge({
            name: 'workadventure_nb_clients_per_room',
            help: 'Number of clients per room',
            labelNames: [ 'room' ]
        });

        // Authentication with token. it will be decoded and stored in the socket.
        // Completely commented for now, as we do not use the "/login" route at all.
        this.Io.use((socket: Socket, next) => {
            console.log(socket.handshake.query.token);
            if (!socket.handshake.query || !socket.handshake.query.token) {
                console.error('An authentication error happened, a user tried to connect without a token.');
                return next(new Error('Authentication error'));
            }
            if(socket.handshake.query.token === 'test'){
                if (ALLOW_ARTILLERY) {
                    (socket as ExSocketInterface).token = socket.handshake.query.token;
                    (socket as ExSocketInterface).userId = uuid();
                    (socket as ExSocketInterface).isArtillery = true;
                    console.log((socket as ExSocketInterface).userId);
                    next();
                    return;
                } else {
                    console.warn("In order to perform a load-testing test on this environment, you must set the ALLOW_ARTILLERY environment variable to 'true'");
                    next();
                }
            }
            (socket as ExSocketInterface).isArtillery = false;
            if(this.searchClientByToken(socket.handshake.query.token)){
                console.error('An authentication error happened, a user tried to connect while its token is already connected.');
                return next(new Error('Authentication error'));
            }
            Jwt.verify(socket.handshake.query.token, SECRET_KEY, (err: JsonWebTokenError, tokenDecoded: object) => {
                if (err) {
                    console.error('An authentication error happened, invalid JsonWebToken.', err);
                    return next(new Error('Authentication error'));
                }

                if (!this.isValidToken(tokenDecoded)) {
                    return next(new Error('Authentication error, invalid token structure'));
                }

                (socket as ExSocketInterface).token = socket.handshake.query.token;
                (socket as ExSocketInterface).userId = tokenDecoded.userId;
                next();
            });
        });

        this.ioConnection();
    }

    private isValidToken(token: object): token is TokenInterface {
        if (typeof((token as TokenInterface).userId) !== 'string') {
            return false;
        }
        if (typeof((token as TokenInterface).name) !== 'string') {
            return false;
        }
        return true;
    }

    /**
     *
     * @param token
     */
    searchClientByToken(token: string): ExSocketInterface | null {
        const clients: ExSocketInterface[] = Object.values(this.Io.sockets.sockets) as ExSocketInterface[];
        for (let i = 0; i < clients.length; i++) {
            const client = clients[i];
            if (client.token !== token) {
                continue
            }
            return client;
        }
        return null;
    }

    ioConnection() {
        this.Io.on(SockerIoEvent.CONNECTION, (socket: Socket) => {
            const client : ExSocketInterface = socket as ExSocketInterface;
            client.batchedMessages = [];
            client.batchTimeout = null;
            client.emitInBatch = (event: string | symbol, payload: unknown): void => {
                emitInBatch(client, event, payload);
            }
            this.sockets.set(client.userId, client);

            // Let's log server load when a user joins
            const srvSockets = this.Io.sockets.sockets;
            this.nbClientsGauge.inc();
            console.log(new Date().toISOString() + ' A user joined (', Object.keys(srvSockets).length, ' connected users)');
            si.currentLoad().then(data => console.log('  Current load: ', data.avgload));
            si.currentLoad().then(data => console.log('  CPU: ', data.currentload, '%'));
            // End log server load

            /*join-rom event permit to join one room.
                message :
                    userId : user identification
                    roomId: room identification
                    position: position of user in map
                        x: user x position on map
                        y: user y position on map
            */
            socket.on(SockerIoEvent.JOIN_ROOM, (message: unknown, answerFn): void => {
                console.log(SockerIoEvent.JOIN_ROOM, message);
                try {
                    if (!isJoinRoomMessageInterface(message)) {
                        socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid JOIN_ROOM message.'});
                        console.warn('Invalid JOIN_ROOM message received: ', message);
                        return;
                    }
                    const roomId = message.roomId;

                    const Client = (socket as ExSocketInterface);

                    if (Client.roomId === roomId) {
                        return;
                    }

                    //leave previous room
                    this.leaveRoom(Client);

                    //join new previous room
                    const world = this.joinRoom(Client, roomId, message.position);

                    const things = world.setViewport(Client, message.viewport);

                    const listOfUsers: Array<MessageUserPosition> = [];
                    const listOfGroups: Array<GroupUpdateInterface> = [];

                    for (const thing of things) {
                        if (thing instanceof User) {
                            const player: ExSocketInterface|undefined = this.sockets.get(thing.id);
                            if (player === undefined) {
                                console.warn('Something went wrong. The World contains a user "'+thing.id+"' but this user does not exist in the sockets list!");
                                continue;
                            }

                            listOfUsers.push(new MessageUserPosition(thing.id, player.name, player.characterLayers, player.position));
                        } else if (thing instanceof Group) {
                            listOfGroups.push({
                                groupId: thing.getId(),
                                position: thing.getPosition(),
                            });
                        } else {
                            console.error("Unexpected type for Movable returned by setViewport");
                        }
                    }

                    const listOfItems: {[itemId: string]: unknown} = {};
                    for (const [itemId, item] of world.getItemsState().entries()) {
                        listOfItems[itemId] = item;
                    }

                    //console.warn('ANSWER PLAYER POSITIONS', listOfUsers);
                    if (answerFn === undefined && ALLOW_ARTILLERY === true) {
                        // For some reason, answerFn can be undefined if we use Artillery (?)
                        return;
                    }

                    answerFn({
                        users: listOfUsers,
                        groups: listOfGroups,
                        items: listOfItems
                    });
                } catch (e) {
                    console.error('An error occurred on "join_room" event');
                    console.error(e);
                }
            });

            socket.on(SockerIoEvent.SET_VIEWPORT, (message: unknown): void => {
                try {
                    //console.log('SET_VIEWPORT')
                    if (!isViewport(message)) {
                        socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid SET_VIEWPORT message.'});
                        console.warn('Invalid SET_VIEWPORT message received: ', message);
                        return;
                    }

                    const Client = (socket as ExSocketInterface);
                    Client.viewport = message;

                    const world = this.Worlds.get(Client.roomId);
                    if (!world) {
                        console.error("In SET_VIEWPORT, could not find world with id '", Client.roomId, "'");
                        return;
                    }
                    world.setViewport(Client, Client.viewport);
                } catch (e) {
                    console.error('An error occurred on "SET_VIEWPORT" event');
                    console.error(e);
                }
            });

            socket.on(SockerIoEvent.USER_POSITION, (userMovesMessage: unknown): void => {
                //console.log(SockerIoEvent.USER_POSITION, userMovesMessage);
                try {
                    if (!isUserMovesInterface(userMovesMessage)) {
                        socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid USER_POSITION message.'});
                        console.warn('Invalid USER_POSITION message received: ', userMovesMessage);
                        return;
                    }

                    const Client = (socket as ExSocketInterface);

                    // sending to all clients in room except sender
                    Client.position = userMovesMessage.position;
                    Client.viewport = userMovesMessage.viewport;

                    // update position in the world
                    const world = this.Worlds.get(Client.roomId);
                    if (!world) {
                        console.error("In USER_POSITION, could not find world with id '", Client.roomId, "'");
                        return;
                    }
                    world.updatePosition(Client, Client.position);
                    world.setViewport(Client, Client.viewport);
                } catch (e) {
                    console.error('An error occurred on "user_position" event');
                    console.error(e);
                }
            });

            socket.on(SockerIoEvent.WEBRTC_SIGNAL, (data: unknown) => {
                this.emitVideo((socket as ExSocketInterface), data);
            });

            socket.on(SockerIoEvent.WEBRTC_SCREEN_SHARING_SIGNAL, (data: unknown) => {
                this.emitScreenSharing((socket as ExSocketInterface), data);
            });

            socket.on(SockerIoEvent.DISCONNECT, () => {
                const Client = (socket as ExSocketInterface);
                try {
                    //leave room
                    this.leaveRoom(Client);

                    //leave webrtc room
                    //socket.leave(Client.webRtcRoomId);

                    //delete all socket information
                    delete Client.webRtcRoomId;
                    delete Client.roomId;
                    delete Client.token;
                    delete Client.position;
                } catch (e) {
                    console.error('An error occurred on "disconnect"');
                    console.error(e);
                }
                this.sockets.delete(Client.userId);

                // Let's log server load when a user leaves
                const srvSockets = this.Io.sockets.sockets;
                this.nbClientsGauge.dec();
                console.log('A user left (', Object.keys(srvSockets).length, ' connected users)');
                si.currentLoad().then(data => console.log('Current load: ', data.avgload));
                si.currentLoad().then(data => console.log('CPU: ', data.currentload, '%'));
                // End log server load
            });

            // Let's send the user id to the user
            socket.on(SockerIoEvent.SET_PLAYER_DETAILS, (playerDetails: unknown, answerFn) => {
                console.log(SockerIoEvent.SET_PLAYER_DETAILS, playerDetails);
                if (!isSetPlayerDetailsMessage(playerDetails)) {
                    socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid SET_PLAYER_DETAILS message.'});
                    console.warn('Invalid SET_PLAYER_DETAILS message received: ', playerDetails);
                    return;
                }
                const Client = (socket as ExSocketInterface);
                Client.name = playerDetails.name;
                Client.characterLayers = playerDetails.characterLayers;
                // Artillery fails when receiving an acknowledgement that is not a JSON object
                if (!Client.isArtillery) {
                    answerFn(Client.userId);
                }
            });

            socket.on(SockerIoEvent.SET_SILENT, (silent: unknown) => {
                console.log(SockerIoEvent.SET_SILENT, silent);
                if (typeof silent !== "boolean") {
                    socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid SET_SILENT message.'});
                    console.warn('Invalid SET_SILENT message received: ', silent);
                    return;
                }

                try {
                    const Client = (socket as ExSocketInterface);

                    // update position in the world
                    const world = this.Worlds.get(Client.roomId);
                    if (!world) {
                        console.error("In SET_SILENT, could not find world with id '", Client.roomId, "'");
                        return;
                    }
                    world.setSilent(Client, silent);
                } catch (e) {
                    console.error('An error occurred on "SET_SILENT"');
                    console.error(e);
                }
            });

            socket.on(SockerIoEvent.ITEM_EVENT, (itemEvent: unknown) => {
                if (!isItemEventMessageInterface(itemEvent)) {
                    socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid ITEM_EVENT message.'});
                    console.warn('Invalid ITEM_EVENT message received: ', itemEvent);
                    return;
                }
                try {
                    const Client = (socket as ExSocketInterface);

                    socket.to(Client.roomId).emit(SockerIoEvent.ITEM_EVENT, itemEvent);

                    const world = this.Worlds.get(Client.roomId);
                    if (!world) {
                        console.error("Could not find world with id '", Client.roomId, "'");
                        return;
                    }
                    world.setItemState(itemEvent.itemId, itemEvent.state);
                } catch (e) {
                    console.error('An error occurred on "item_event"');
                    console.error(e);
                }
            });
        });
    }

    emitVideo(socket: ExSocketInterface, data: unknown){
        if (!isWebRtcSignalMessageInterface(data)) {
            socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid WEBRTC_SIGNAL message.'});
            console.warn('Invalid WEBRTC_SIGNAL message received: ', data);
            return;
        }
        //send only at user
        const client = this.sockets.get(data.receiverId);
        if (client === undefined) {
            console.warn("While exchanging a WebRTC signal: client with id ", data.receiverId, " does not exist. This might be a race condition.");
            return;
        }
        return client.emit(SockerIoEvent.WEBRTC_SIGNAL, {
            userId: socket.userId,
            signal: data.signal
        });
    }

    emitScreenSharing(socket: ExSocketInterface, data: unknown){
        if (!isWebRtcSignalMessageInterface(data)) {
            socket.emit(SockerIoEvent.MESSAGE_ERROR, {message: 'Invalid WEBRTC_SCREEN_SHARING message.'});
            console.warn('Invalid WEBRTC_SCREEN_SHARING message received: ', data);
            return;
        }
        //send only at user
        const client = this.sockets.get(data.receiverId);
        if (client === undefined) {
            console.warn("While exchanging a WEBRTC_SCREEN_SHARING signal: client with id ", data.receiverId, " does not exist. This might be a race condition.");
            return;
        }
        return client.emit(SockerIoEvent.WEBRTC_SCREEN_SHARING_SIGNAL, {
            userId: socket.userId,
            signal: data.signal
        });
    }

    searchClientByIdOrFail(userId: string): ExSocketInterface {
        const client: ExSocketInterface|undefined = this.sockets.get(userId);
        if (client === undefined) {
            throw new Error("Could not find user with id " + userId);
        }
        return client;
    }

    leaveRoom(Client : ExSocketInterface){
        // leave previous room and world
        if(Client.roomId){
            try {
                //user leave previous world
                const world: World | undefined = this.Worlds.get(Client.roomId);
                if (world) {
                    world.leave(Client);
                    if (world.isEmpty()) {
                        this.Worlds.delete(Client.roomId);
                    }
                }
                //user leave previous room
                Client.leave(Client.roomId);
            } finally {
                this.nbClientsPerRoomGauge.dec({ room: Client.roomId });
                delete Client.roomId;
            }
        }
    }

    private joinRoom(Client : ExSocketInterface, roomId: string, position: PointInterface): World {
        //join user in room
        Client.join(roomId);
        this.nbClientsPerRoomGauge.inc({ room: roomId });
        Client.roomId = roomId;
        Client.position = position;

        //check and create new world for a room
        let world = this.Worlds.get(roomId)
        if(world === undefined){
            world = new World((user1: string, group: Group) => {
                this.connectedUser(user1, group);
            }, (user1: string, group: Group) => {
                this.disConnectedUser(user1, group);
            }, MINIMUM_DISTANCE, GROUP_RADIUS, (thing: Movable, listener: User) => {
                const clientListener = this.searchClientByIdOrFail(listener.id);
                if (thing instanceof User) {
                    const clientUser = this.searchClientByIdOrFail(thing.id);
                    const messageUserJoined = new MessageUserJoined(clientUser.userId, clientUser.name, clientUser.characterLayers, clientUser.position);

                    clientListener.emit(SockerIoEvent.JOIN_ROOM, messageUserJoined);
                } else if (thing instanceof Group) {
                    clientListener.emit(SockerIoEvent.GROUP_CREATE_UPDATE, {
                        position: thing.getPosition(),
                        groupId: thing.getId()
                    } as GroupUpdateInterface);
                } else {
                    console.error('Unexpected type for Movable.');
                }
            }, (thing: Movable, position, listener) => {
                const clientListener = this.searchClientByIdOrFail(listener.id);
                if (thing instanceof User) {
                    const clientUser = this.searchClientByIdOrFail(thing.id);

                    clientListener.emitInBatch(SockerIoEvent.USER_MOVED, new MessageUserMoved(clientUser.userId, clientUser.position));
                    //console.log("Sending USER_MOVED event");
                } else if (thing instanceof Group) {
                    clientListener.emit(SockerIoEvent.GROUP_CREATE_UPDATE, {
                        position: thing.getPosition(),
                        groupId: thing.getId()
                    } as GroupUpdateInterface);
                } else {
                    console.error('Unexpected type for Movable.');
                }
            }, (thing: Movable, listener) => {
                const clientListener = this.searchClientByIdOrFail(listener.id);
                if (thing instanceof User) {
                    const clientUser = this.searchClientByIdOrFail(thing.id);
                    clientListener.emit(SockerIoEvent.USER_LEFT, clientUser.userId);
                    //console.log("Sending USER_LEFT event");
                } else if (thing instanceof Group) {
                    clientListener.emit(SockerIoEvent.GROUP_DELETE, thing.getId());
                } else {
                    console.error('Unexpected type for Movable.');
                }

            });
            this.Worlds.set(roomId, world);
        }

        // Dispatch groups position to newly connected user
        world.getGroups().forEach((group: Group) => {
            Client.emit(SockerIoEvent.GROUP_CREATE_UPDATE, {
                position: group.getPosition(),
                groupId: group.getId()
            } as GroupUpdateInterface);
        });
        //join world
        world.join(Client, Client.position);
        return world;
    }

    /**
     *
     * @param socket
     * @param roomId
     */
    joinWebRtcRoom(socket: ExSocketInterface, roomId: string) {
        if (socket.webRtcRoomId === roomId) {
            return;
        }
        socket.join(roomId);
        socket.webRtcRoomId = roomId;
        //if two persons in room share
        if (this.Io.sockets.adapter.rooms[roomId].length < 2 /*|| this.Io.sockets.adapter.rooms[roomId].length >= 4*/) {
            return;
        }

        // TODO: scanning all sockets is maybe not the most efficient
        const clients: Array<ExSocketInterface> = (Object.values(this.Io.sockets.sockets) as Array<ExSocketInterface>)
            .filter((client: ExSocketInterface) => client.webRtcRoomId && client.webRtcRoomId === roomId);
        //send start at one client to initialise offer webrtc
        //send all users in room to create PeerConnection in front
        clients.forEach((client: ExSocketInterface, index: number) => {

            const peerClients = clients.reduce((tabs: Array<UserInGroupInterface>, clientId: ExSocketInterface, indexClientId: number) => {
                if (!clientId.userId || clientId.userId === client.userId) {
                    return tabs;
                }
                tabs.push({
                    userId: clientId.userId,
                    name: clientId.name,
                    initiator: index <= indexClientId
                });
                return tabs;
            }, []);

            client.emit(SockerIoEvent.WEBRTC_START, {clients: peerClients, roomId: roomId});
        });
    }

    /** permit to share user position
     ** users position will send in event 'user-position'
     ** The data sent is an array with information for each user :
     [
     {
            userId: <string>,
            roomId: <string>,
            position: {
                x : <number>,
                y : <number>,
               direction: <string>
            }
          },
     ...
     ]
     **/

    //connected user
    connectedUser(userId: string, group: Group) {
        /*let Client = this.sockets.get(userId);
        if (Client === undefined) {
            return;
        }*/
        const Client = this.searchClientByIdOrFail(userId);
        this.joinWebRtcRoom(Client, group.getId());
    }

    //disconnect user
    disConnectedUser(userId: string, group: Group) {
        const Client = this.searchClientByIdOrFail(userId);
        Client.to(group.getId()).emit(SockerIoEvent.WEBRTC_DISCONNECT, {
            userId: userId
        });

        // Most of the time, sending a disconnect event to one of the players is enough (the player will close the connection
        // which will be shut for the other player).
        // However! In the rare case where the WebRTC connection is not yet established, if we close the connection on one of the player,
        // the other player will try connecting until a timeout happens (during this time, the connection icon will be displayed for nothing).
        // So we also send the disconnect event to the other player.
        for (const user of group.getUsers()) {
            Client.emit(SockerIoEvent.WEBRTC_DISCONNECT, {
                userId: user.id
            });
        }

        //disconnect webrtc room
        if(!Client.webRtcRoomId){
            return;
        }
        Client.leave(Client.webRtcRoomId);
        delete Client.webRtcRoomId;
    }
}
