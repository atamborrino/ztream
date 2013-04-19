# Ztream

Ztream is a proof of concept for **P2P Web music streaming** built with [WebRTC](http://www.webrtc.org/), [Media Source API]("https://dvcs.w3.org/hg/html-media/raw-file/tip/media-source/media-source.html"), [Play Framework]("http://www.playframework.com/") (Scala) and [ReactiveMongo]("http://reactivemongo.org/").  
Streaming is performed by a combination of client-server access and P2P protocol between Web users. This is done in an 
adaptive and transparent way in order to reduce server bandwidth costs while ensuring low latency for users.

The method used is a simplified and Web-transposed version of the [architecture](http://www.csc.kth.se/~gkreitz/spotify-p2p10/spotify-p2p10.pdf) of the Spotify's desktop client.

**[-> LIVE DEMO <-](http://ztream.atamborrino.cloudbees.net/)**

## How it works

Each peer (Web client) has 2 Websocket connections to the server: a *control* connection and a *streaming* binary connection. The control connection is used to handle all the control messages including the WebRTC's offer/answer messages.  
An user can request to the server a series of chunks of the track he wants via the stream connection.

Here is what a peer does when his user chooses a track to listen to:

1. If the track is in his local cache, he just plays it from there
2. Otherwise, he will ask the server for the first chunks of the track (equivalent to ~10s) so that the playback can begin instantly (as the server is fast)
3. In the meantime, the client asks the tracker to find a peer that has this track
4. The tracker asks the last 20 peers that have entirely streamed the track if they can stream it (a peer can not stream to more than 2 other peers). The first to respond positively to the server (= the seeder) is selected and its id is sent back the the inital peer (= the leecher).
5. A WebRTC PeerConnection is made between the leecher and the seeder, and the leecher can start streaming chunks of the track from the seeder via a binary DataChannel.
6. At any time, if there is only around 3 seconds left in the playback buffer, the leecher stops streaming from the seeder (if there is any) and asks the server the next chunks of the track. This is a kind of emergency mode that occurs when no seeder is found or when the seeder is streaming too slowly. After receiving these new chunks, the leecher starts again streaming from the seeder or keep on searching for one.

Moreover, on the server-side, upon a stream request of an user (random access from chunk x to chunk y of a track), the server streams the requested series of chunks directly from MongoDB and redirects this stream towards the client's Websocket (so there is never an accumulation of chunks in the server memory). ReactiveMongo and its use of Play's Iteratee allows you to build such a reactive stream out-of-the-box with a few lines of code.

Check the code for more details!

Note on audio format: Media Source currently only supports webm files (put in a html video element even for audio). You can easily convert your music to webm via ffmpeg:
    ffmpeg -i music.ogg -strict -2 music.webm

## TODOs / Ideas

* For now, streamed tracks are cached in-memory on the client side (not a problem as the client can only stream one track in the demo). But for a multi-tracks Web client, the tracks should be cached in the FileSystem API instead of in-memory in order to have a persistent cache and more space.

* When a peer already knows some other peers (= he has a PeerConnection with them due to a past leecher/seeder relation), he can directly ask these peers if they have some tracks without using the tracker (i.e a decentralized P2P network is built, like in Spotify).

* Instead of proposing tracks from Mongo, tracks (chunks) may be directly streamed by the server from services like SoundCloud, making Ztream a proxy to reduce streaming server bandwidth costs by orchestrating P2P communication between clients. If needeed, re-encoding could be done on the fly via ffmpeg thanks to [playCLI API](https://github.com/gre/playCLI) that allows to transform Linux pipes into Enumeratee!

Feel free to fork and experiment =)

## Author

Alexandre Tamborrino

* [@altamborrino](https://twitter.com/altamborrino)
* tamborrino.alexandre@gmail.com






