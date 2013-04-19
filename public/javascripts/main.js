requirejs.config({
    shim: {
        'vendor/jquery': {
            exports: '$'
        },
        'vendor/base64': {
            exports: 'base64'
        }
    }
});

require(["helper/util","vendor/base64", "vendor/jquery"], function(u, base64, $) { 
  "use strict";

  // STUN server
  var SERVER = "stun:stun.l.google.com:19302";

  // Check compatibilty
  var RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
  var MediaSource = window.MediaSource || window.WebKitMediaSource || window.mozMediaSource;
  var compatible = false;
  var pc;
  try {
    if (RTCPeerConnection && MediaSource) {
      pc = new RTCPeerConnection({"iceServers": [{"url": SERVER}]},{ optional:[ { RtpDataChannels: true }]});
      var dc = pc.createDataChannel("test", {reliable: false});
      if (dc) {
        compatible = true;
      } 
    }
  } catch (e) {
  } finally {
    if (pc) {
      pc.close();
    }
  }
  if (!compatible) {
    $("#not-compatible").removeClass("hidden");
    $("#totalNumberPeers").text("-");
  }

  // Map of peerId -> peerConnection
  var peers = {};
  var MAX_LEECHERS_PER_SEEDER = 2;

  // Potential seeder and wanted track information (the client is designed for only one track for now)
  var seederConn = null; // peer connection
  var seedChan = null; // data channel
  var trackName = $("#trackName").text();
  var totalNChunk = parseInt($("#totalNbChunk").text(),10); // total number of chunks of the track
  var track = []; // array of chunks (in-memory cache)

  // Audio
  var audio = null; // html audio tag
  var mediaSource = null;
  var sourceBuffer = null;

  // streaming from server
  var CHUNK_WINDOW = 700; // number of chunks we ask to server each time we need to
  var chunkNInsideWindow = -1; // higher chunk number received inside the current chunk window streamed from server
  var HEARTBEAT_INTERVAL = 9000;

  var MIN_BUFFER_TIME = 3; // min ahead time (seconds) authorized for the buffer. If less, we go in emergency mode.

  // internal state
  var emergencyMode = false; // true if we need to stream from server right now (buffer is too low)
  var peerRequested = false;
  var nbCurrentLeechers = 0; // leechers which we are seeding to right now
  var seederIsSuspected = false; // suspected == maybeDead

  // info for UI
  var chunkFromServer = 0;
  var chunkFromPeers = 0;


  // leecher side
  function P2PstreamRequest(seederConn) {
    seedChan = seederConn.createDataChannel(trackName,{ reliable : false });
    seedChan.binaryType = "arraybuffer";

    $("#connectedToSeeder").text(true);
    u.trace("Going to open DataChannel");

    seedChan.onopen = function() {
      u.trace("DataChannel opened");
      if (!emergencyMode) {
        u.trace("Sending P2P stream request");
        seedChan.send(JSON.stringify({"from":track.length}));
      }
    };

    seedChan.onmessage = function(evt) {
      seederIsSuspected = false;
      if (!emergencyMode) {
        var binaryData = base64.decode(evt.data);
        var chunkNum = new Uint32Array(binaryData.slice(0,4))[0];
        u.trace("P2P: rcv: chunk "+chunkNum);
        if (chunkNum === track.length) {
          var chunk = binaryData.slice(4);
          track.push(chunk);
          chunkFromPeers +=1;
          $("#chunkN").text(track.length);
          $("#percentagePeers").text(Math.ceil((chunkFromPeers+1)*100/totalNChunk));
          appendToPlayback(chunk);

          if (streamEnded()){
            ctrlSocket.send(u.mess("streamEnded",{"trackName":trackName}));
            mediaSource.endOfStream();
            $("#totalTime").text(u.formatTime(audio.duration)); // hack, should not be needed
          }
        } else {
          u.trace("rcv chunk from P2P but wrong number");
        }
      } else {
        u.trace("rcv chunk from P2P but emergency mode");
        // ignoring chunk (it arrived too late!)
        // TODO: implement "stop" message ?
      }
    };

    seedChan.onclose = function() {
      // Peer have closed the connection before the seeker have downloaded the full track
      if (seederConn !== null) { // == if we have not suspected the seeder before (onclose can be much delayed)
        u.trace("data channel closed");
        seedChan = null;
        try {
          seederConn.close();
        } catch(err) {}
        seederConn = null;
        seederIsSuspected = false;
        $("#connectedToSeeder").text(false);
      }
    }

  }

  // seeder side
  function onP2PstreamRequest(evt) { 
    u.trace("DataChannel opened");
    var chan = evt.channel;
    chan.binaryType = "arraybuffer";
    var trackWanted = chan.label;
    var cancellable = null;

    chan.onmessage = function (evt) {
      u.trace("Rcving P2P stream request");
      var req = JSON.parse(evt.data);
      if (cancellable !== null) {
        // cancelling previous sending
        clearInterval(cancellable);
      } else {
        nbCurrentLeechers += 1;
      }
      var chunkI = req.from;
      $("#nbLeechers").text(nbCurrentLeechers);

      function sendProgressively() {
        // goal rate: 50 kb/s
        for(var i = 0; (chunkI < track.length && i < 100); i++) {
          var chunkNum = new Uint32Array(1);
          chunkNum[0] = chunkI;
          var chunk = u.UInt32concat(chunkNum, new Uint32Array(track[chunkI])).buffer;
          var b64encoded = base64.encode(chunk);
          chan.send(b64encoded);
          chunkI++;
          u.trace("P2P: send chunk "+chunkI);
        }
        if (chunkI >= track.length) {
          clearInterval(cancellable);
          cancellable = null;
          nbCurrentLeechers -= 1;
          $("#nbLeechers").text(nbCurrentLeechers);
        }
      }
      sendProgressively();
      cancellable = setInterval(sendProgressively, 1000);
    };

    chan.onclose = function () {
      u.trace("datachannel closed");
      nbCurrentLeechers -= 1;
      $("#nbLeechers").text(nbCurrentLeechers);
    };

  }

  function streamFromServer(fromChunkN,toChunkN) {
      // enter server streaming mode
      if (chunkNInsideWindow === -1) { // no other concurrent requests
        chunkNInsideWindow = 0;
        emergencyMode = true;
        var req = {"trackName":trackName,"from":fromChunkN,"to":toChunkN};
        u.trace(JSON.stringify(req));
        streamSocket.send(u.str2ab(JSON.stringify(req)));
      }
  }

  function isEmergencyMode() {
    var lastBuffered = audio.buffered.end(audio.buffered.length-1);
    return (!streamEnded() && (audio.currentTime > lastBuffered - MIN_BUFFER_TIME));
  }

  function appendToPlayback(chunk) {
    sourceBuffer.append(new Uint8Array(chunk));
  }

  function seekPeer() {
    if (!peerRequested){
      ctrlSocket.send(u.mess("seekPeer",{"trackName":trackName}));
      u.trace("SEEK NEW PEER");
      peerRequested = true;
    }
  }

  function streamEnded() {
    return (track.length >= totalNChunk);
  }


  // Webscocket connections
  if (compatible) {
    var ctrlSocket = new WebSocket(u.wsUrl("control")); 
    var streamSocket = new WebSocket(u.wsUrl("stream"));
    streamSocket.binaryType = "arraybuffer";

    // control WS events
    ctrlSocket.onopen = function() {
      setInterval(function() {
        ctrlSocket.send(u.mess("heartbeat",{}));
      }, HEARTBEAT_INTERVAL);
    };
    ctrlSocket.onmessage = function(evt) {
      var parsedWsEvt = JSON.parse(evt.data);
      var event = parsedWsEvt.event;
      var data = parsedWsEvt.data;
      //u.trace("Rcv: "+evt.data);

      if (event === "reqPeer") {
        var trackWanted = data.trackName;
        // testing if we have the track and if we dont stream to too many peers yet
        if (trackWanted === trackName && track.length === totalNChunk && nbCurrentLeechers < MAX_LEECHERS_PER_SEEDER) {
          // ok
          ctrlSocket.send(u.mess("respReqPeer",
            {"trackName":trackWanted,"seekId":data.seekId,"seekerId":data.seekerId}));
        }
      }

      else if (event === "peerNotFound") {
        peerRequested = false;
      }

      else if (event === "info") {
        $("#totalNumberPeers").text(data.peers);
      }

      // WebRTC caller side (leecher)
      else if (event === "peerFound" && seederConn === null) {
        // seeder found
        peerRequested = false;
        var seederId = data.seederId;

        seederConn = new RTCPeerConnection({"iceServers": [{"url": SERVER}]},{ optional:[ { RtpDataChannels: true }]});
        u.trace("establishing P2P connection caller side (leecher)");

        seederConn.onicecandidate = function(iceEvt) {
            if (iceEvt.candidate) {
              ctrlSocket.send(u.fwdMess(seederId,"callerIceCandidate",
                {"trackName":trackName,"candidate": iceEvt.candidate }));
            }
        };
        seederConn.onnegotiationneeded = function() {
          seederConn.createOffer(function(desc){
              seederConn.setLocalDescription(desc, function() {
                ctrlSocket.send(u.fwdMess(seederId,"rtcOffer",
                  {"trackName":trackName,"sdp": desc }));
              });
          });
        };

        P2PstreamRequest(seederConn);
      }

      // WebRTC callee side (seeder)
      else if (event === "rtcOffer" || event === "callerIceCandidate") {
        var leecherId = parsedWsEvt.from;

        if (!peers.hasOwnProperty(leecherId)) {
          //creation of new P2P connection
          var leecherConn = new RTCPeerConnection({"iceServers": [{"url": SERVER}]},
            { optional:[ { RtpDataChannels: true } ]});

          leecherConn.onicecandidate = function (iceEvt) {
            if (iceEvt.candidate) {
              ctrlSocket.send(u.fwdMess(leecherId,"calleeIceCandidate",
                {"trackName":trackName,"candidate": iceEvt.candidate }));
            } else {
              u.trace("No more Ice candidate");
            }
          };

          leecherConn.ondatachannel = function(evt) { onP2PstreamRequest(evt); };
          peers[leecherId] = leecherConn;
        }

        var leecherConn = peers[leecherId];
        if (event === "rtcOffer") {
          leecherConn.setRemoteDescription(new RTCSessionDescription(data.sdp), function() {
            u.trace("rtc offer set"); 
            leecherConn.createAnswer(function(desc){
              leecherConn.setLocalDescription(desc, function() {
                ctrlSocket.send(u.fwdMess(leecherId,"rtcAnswer",
                  {"trackName":trackName,"sdp": desc }));
              });
            });
          });
        }
        else if (event === "callerIceCandidate") {
          leecherConn.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      }

      // WebRTC caller side (leecher)
      else if (event === "rtcAnswer" && seederConn !== null) {
        seederConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
      }

      // WebRTC caller side (leecher)
      else if (event === "calleeIceCandidate" && seederConn !== null) {
        seederConn.addIceCandidate(new RTCIceCandidate(data.candidate));
      }

    };


    // stream WS events
    streamSocket.onmessage = function (event) {
      var chunk = event.data;
      track.push(chunk);
      appendToPlayback(chunk);
      chunkNInsideWindow += 1;
      chunkFromServer += 1;

      $("#chunkN").text(track.length);
      $("#percentageServer").text(Math.floor((chunkFromServer+1)*100/totalNChunk));

      if (streamEnded()){
        chunkNInsideWindow = -1;
        ctrlSocket.send(u.mess("streamEnded",{"trackName":trackName}));
        emergencyMode = false;
        mediaSource.endOfStream();
        $("#totalTime").text(u.formatTime(audio.duration)); // hack, should not be needed
      } else if (chunkNInsideWindow >= CHUNK_WINDOW) {
        // end of the stream response of CHUNK_WINDOW chunks
        chunkNInsideWindow = -1;
        emergencyMode = false;
        // recontact seeder to ask for chunks
        if (seedChan !== null && seedChan.readyState === "open") {
          if (seederIsSuspected) {
            u.trace("seeder is inactive");
            seedChan.close();
            seederConn.close();
            seedChan = null;
            seederConn = null;
            seederIsSuspected = false;
            $("#connectedToSeeder").text(false);
            seekPeer();
          } else {
            u.trace("Sending P2P stream request from "+track.length);
            seedChan.send(JSON.stringify({"from":track.length}));
            seederIsSuspected = true;
          }
        } else {
          seekPeer();
        }
      }
    }
    
  }


  // User events
  $("#playButton").click(function() {
    if (!compatible) {
      $(".warning").fadeTo(250,0.01).fadeTo(250,1);
    } else {
      if (audio === null || audio.currentTime === 0 || audio.ended) {
        // new playback of the track
        $("#track").remove();
        $("#player").prepend('<video id="track"></video>'); // use of video tag as an audio tag
        $("#track").hide();

        audio = $('#track').get(0);
        mediaSource = new MediaSource();
        audio.src = window.URL.createObjectURL(mediaSource);

        audio.addEventListener("canplay", function() {
          $("#totalTime").text(u.formatTime(audio.duration));
        },false);

        audio.addEventListener("timeupdate", function() {
          // setting emergency streaming from server if there is less
          // than 3 seconds until the end of the buffer
          if (isEmergencyMode()) {
            streamFromServer(track.length,track.length+CHUNK_WINDOW);
          }
          $("#currentTime").text(u.formatTime(audio.currentTime));
        },false);

        audio.addEventListener("ended", function(){
          $("#playButton").attr("src","assets/images/play.png");
          if (!($("#fromCache").length)) {
            $("#playButton").after('<span id="fromCache">from cache</span>');
          }
        },false);

        mediaSource.addEventListener('webkitsourceopen', function(e) {
          sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs="vorbis"');
          if (track.length > 0) {
            // play from cache
            for (var i = 0; i < track.length; i++) {
              appendToPlayback(track[i]);
            }
            if (streamEnded()) {
              mediaSource.endOfStream();
            }
          }
          else {
            streamFromServer(0,CHUNK_WINDOW);
          }
          
          if (track.length < totalNChunk) {
            seekPeer();
          }
        },false);

        audio.play();
        $("#playButton").attr("src","assets/images/pause.png");

      } else {
        // play/pause
        if (audio.paused){
          $("#playButton").attr("src","assets/images/pause.png");
          audio.play();
        } else {
          $("#playButton").attr("src","assets/images/play.png");
          audio.pause();
        }
      } 
    }
    return false;
  });


  // UI 
  u.preload(["assets/images/pause.png"]);

});