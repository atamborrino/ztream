'use strict';

var services = angular.module('ztream.services', []);

services.factory('P2Pplayer', function(ctrlSocket, streamSocket, util, $http, $window, $rootScope) {
  var S = {}; // returned Service
  S.trackName = "gangnamstyle.webm"; // hardcoded for now
  S.totalNbChunks = null;
  $http.get('/trackmetainfo/' + S.trackName).success(function(data) {
    S.totalNbChunks = data.nbChunks;
  });
  S.track = [] // array of chunks (in-memory cache)
  S.audio = $window.document.createElement('video'); // <audio> does not support Media Source API yet
  S.nbChunksFromServer = 0;
  S.nbChunksFromPeers = 0;
  S.nbCurrentLeechers = 0; // leechers which we are seeding to right now
  S.totalNbPeers = 0;

  var STUN_SERVER = 'stun:stun.l.google.com:19302';
  var RTCPeerConnection = $window.RTCPeerConnection || $window.webkitRTCPeerConnection || $window.mozRTCPeerConnection;
  var MediaSource = $window.MediaSource || $window.WebKitMediaSource || $window.mozMediaSource;

  function isCompatible() {
    var compatible = false;
    var pc;
    try {
      if (RTCPeerConnection && MediaSource) {
        pc = new RTCPeerConnection({'iceServers': [{'url': STUN_SERVER}]},{ optional:[ { RtpDataChannels: true }]});
        var dc = pc.createDataChannel('test', {reliable: true});
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
    return compatible;
  }

  S.compatible = isCompatible();

  // WebRTC and audio internals

  var peers = {}; // Map of peerId -> peerConnection
  var MAX_LEECHERS_PER_SEEDER = 2;
  var seederConn, seedChan; // peer connection and data channel
  var mediaSource, sourceBuffer;

  var CHUNK_WINDOW = 700; // number of chunks we ask to server each time we need to
  var chunkNbInsideWindow = -1; // higher chunk number received inside the current chunk window streamed from server

  var HEARTBEAT_INTERVAL = 30000; // ms
  var MIN_BUFFER_TIME = 4; // min ahead time (seconds) authorized for the buffer. If less, we go in emergency mode.

  var emergencyMode = false; // true if we need to stream from server right now (buffer is too low)
  var peerRequested = false;
  var seederIsSuspected = false; // suspected == maybeDead

  // used with datachannel callbacks
  function apply(fun) {
    return function(event) {
      $rootScope.$apply(function() {return fun(event);});
    }
  }

  // do a P2P stream request (leecher side)
  function P2PstreamRequest(seederConn) {
    seedChan = seederConn.createDataChannel(S.trackName, {reliable : true});
    seedChan.binaryType = 'arraybuffer';

    seedChan.onopen = function() {
      util.trace('DataChannel opened');
      if (!emergencyMode) {
        util.trace('Sending P2P stream request');
        seedChan.send(JSON.stringify({'from': S.track.length}));
      }
    };

    seedChan.onmessage = apply(function(evt) {
      seederIsSuspected = false;
      if (!emergencyMode) {
        var binaryData = base64.decode(evt.data);
        var chunkNum = new Uint32Array(binaryData.slice(0,4))[0];
        if (chunkNum === S.track.length) {
          var chunk = binaryData.slice(4);
          S.track.push(chunk);
          S.nbChunksFromPeers +=1;
          appendToPlayback(chunk);
          if (streamEnded()){
            ctrlSocket.send('streamEnded', {'trackName': S.trackName});
            mediaSource.endOfStream();
          }
        }
      }
    });

    seedChan.onclose = function() {
      // Peer have closed the connection before the seeker have downloaded the full track
      if (seederConn) { // == if we have not suspected the seeder before (onclose can be delayed)
        util.trace('data channel closed');
        seedChan = null;
        try {
          seederConn.close();
        } catch(err) {}
        seederConn = null;
        seederIsSuspected = false;
      }
    }
  }

  // handle a P2P stream request (seeder side)
  function onP2PstreamRequest(evt) { 
    util.trace('DataChannel opened');
    var chan = evt.channel;
    chan.binaryType = 'arraybuffer';
    var trackWanted = chan.label;
    var cancellable;

    chan.onmessage = apply(function(evt) {
      util.trace('Receiving P2P stream request');
      var req = JSON.parse(evt.data);
      if (cancellable) {
        // cancelling previous sending
        clearInterval(cancellable);
      } else {
        S.nbCurrentLeechers += 1;
      }
      var chunkI = req.from;

      function sendProgressively() {
        // goal rate: 75 kb/s
        for(var i = 0; chunkI < S.track.length && i < 150; i++) {
          var chunkNum = new Uint32Array(1);
          chunkNum[0] = chunkI;
          var chunkNumInt8 = new Uint8Array(chunkNum.buffer);
          var chunk = util.UInt8concat(chunkNumInt8, new Uint8Array(S.track[chunkI])).buffer;
          var b64encoded = base64.encode(chunk);
          chan.send(b64encoded);
          chunkI++;
        }
        if (chunkI >= S.track.length) {
          clearInterval(cancellable);
          cancellable = null;
          S.nbCurrentLeechers -= 1;
        }
      }
      sendProgressively();
      cancellable = setInterval(apply(sendProgressively), 1000);
    });

    chan.onclose = apply(function() {
      util.trace('datachannel closed');
      S.nbCurrentLeechers -= 1;
    });

  }

  function streamFromServer(fromChunkN,toChunkN) {
    // enter server streaming mode
    if (chunkNbInsideWindow === -1) { // no other concurrent requests
      chunkNbInsideWindow = 0;
      emergencyMode = true;
      var req = {'trackName': S.trackName,'from':fromChunkN,'to':toChunkN};
      util.trace("Request to server: " + JSON.stringify(req));
      streamSocket.send(util.str2ab(JSON.stringify(req)));
    }
  }

  function isEmergencyMode() {
    var lastBuffered = S.audio.buffered.end(S.audio.buffered.length-1);
    return (!streamEnded() && (S.audio.currentTime > lastBuffered - MIN_BUFFER_TIME));
  }

  function appendToPlayback(chunk) {
    sourceBuffer.append(new Uint8Array(chunk));
  }

  function seekPeer() {
    if (!peerRequested){
      ctrlSocket.send('seekPeer', {'trackName': S.trackName});
      // u.trace('SEEK NEW PEER');
      peerRequested = true;
    }
  }

  function streamEnded() {
    return (S.track.length >= S.totalNbChunks);
  }

  ctrlSocket.on('reqPeer', function(data) {
    var trackWanted = data.trackName;
    // testing if we have the track and if we dont stream to too many peers yet
    if (trackWanted === S.trackName && S.track.length === S.totalNbChunks && S.nbCurrentLeechers < MAX_LEECHERS_PER_SEEDER) {
      ctrlSocket.send('respReqPeer', {'trackName':trackWanted,'seekId':data.seekId,'seekerId':data.seekerId});
    }
  });

  ctrlSocket.on('peerNotFound', function() {
    peerRequested = false;
    util.trace('peer not found');
  });  

  ctrlSocket.on('info', function(data) {
    S.totalNbPeers = data.peers;
  });

  ctrlSocket.on('peerFound', function(data) {
    peerRequested = false;
    if (!seederConn) {
      var seederId = data.seederId;
      seederConn = new RTCPeerConnection({'iceServers': [{'url': STUN_SERVER}]},{ optional:[ { RtpDataChannels: true }]});
      util.trace('establishing P2P connection caller side (leecher)');

      seederConn.onicecandidate = function(iceEvt) {
        if (iceEvt.candidate) {
          ctrlSocket.fwd(seederId,'callerIceCandidate', {'candidate': iceEvt.candidate});
        }
      };
      seederConn.onnegotiationneeded = function() {
        seederConn.createOffer(function(desc){
          seederConn.setLocalDescription(desc, function() {
            desc.sdp = util.transformSdp(desc.sdp);
            ctrlSocket.fwd(seederId,'rtcOffer', {'sdp': desc});
          });
        });
      };

      P2PstreamRequest(seederConn);
    }
  });

  function handleNewLeecher(leecherId) {
    if (!peers.hasOwnProperty(leecherId)) {
      //creation of new P2P connection
      var leecherConn = new RTCPeerConnection({'iceServers': [{'url': STUN_SERVER}]},
        { optional:[ { RtpDataChannels: true } ]});

      leecherConn.onicecandidate = function(iceEvt) {
        if (iceEvt.candidate) {
          ctrlSocket.fwd(leecherId,'calleeIceCandidate', {'candidate': iceEvt.candidate });
        }
      };

      leecherConn.ondatachannel = function(evt) { onP2PstreamRequest(evt); };
      peers[leecherId] = leecherConn;
    }
  }

  ctrlSocket.on('rtcOffer', function(data, leecherId) {
    handleNewLeecher(leecherId);
    var leecherConn = peers[leecherId];
    leecherConn.setRemoteDescription(new RTCSessionDescription(data.sdp), function() { 
      leecherConn.createAnswer(function(desc) {
        desc.sdp = util.transformSdp(desc.sdp);
        leecherConn.setLocalDescription(desc, function() {
          ctrlSocket.fwd(leecherId, 'rtcAnswer', {'sdp': desc });
        });
      });
    });
  });

  ctrlSocket.on('callerIceCandidate', function(data, leecherId) {
    handleNewLeecher(leecherId);
    var leecherConn = peers[leecherId];
    leecherConn.addIceCandidate(new RTCIceCandidate(data.candidate));
  });

  ctrlSocket.on('rtcAnswer', function(data) {
    if (seederConn) {
      seederConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
  });  

  ctrlSocket.on('calleeIceCandidate', function(data) {
    if (seederConn) {
      seederConn.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  });

  streamSocket.onChunk(function(chunk) {
    S.track.push(chunk);
    appendToPlayback(chunk);
    chunkNbInsideWindow += 1;
    S.nbChunksFromServer += 1;

    if (streamEnded()){
      chunkNbInsideWindow = -1;
      ctrlSocket.send('streamEnded',{'trackName': S.trackName});
      emergencyMode = false;
      mediaSource.endOfStream();
    } else if (chunkNbInsideWindow >= CHUNK_WINDOW) {
      // end of the stream response of CHUNK_WINDOW chunks
      chunkNbInsideWindow = -1;
      emergencyMode = false;
      // recontact seeder to ask for chunks
      if (seedChan && seedChan.readyState === 'open') {
        if (seederIsSuspected) {
          util.trace('seeder is inactive. Discarding it...');
          seedChan.close();
          seederConn.close();
          seedChan = null;
          seederConn = null;
          seederIsSuspected = false;
          seekPeer();
        } else {
          util.trace('Sending P2P stream request from '+S.track.length);
          seedChan.send(JSON.stringify({'from':S.track.length}));
          seederIsSuspected = true;
        }
      } else {
        seekPeer();
      }
    }
  });

  S.newPlayback = function() {
    // new playback of the track
    mediaSource = new MediaSource();
    S.audio.src = $window.URL.createObjectURL(mediaSource);
    S.audio.load();

    S.audio.addEventListener('timeupdate', function() {
      // setting emergency streaming from server if there is less
      // than 3 seconds until the end of the buffer
      if (isEmergencyMode()) {
        streamFromServer(S.track.length,S.track.length+CHUNK_WINDOW);
      }

    }, false);

    mediaSource.addEventListener('webkitsourceopen', function(e) {
      sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs="vorbis"');
      if (S.track.length > 0) {
        // play from cache
        for (var i = 0; i < S.track.length; i++) {
          appendToPlayback(S.track[i]);
        }
        if (streamEnded()) {
          mediaSource.endOfStream();
        }
      }
      else {
        streamFromServer(0,CHUNK_WINDOW);
      }
      
      if (S.track.length < S.totalNbChunks) {
        seekPeer();
      }
    }, false);

    function digest() {$rootScope.$digest();}

    S.audio.addEventListener('timeupdate', digest, false);
    S.audio.addEventListener('canplay', digest, false);
    S.audio.addEventListener('ended', digest, false);

    S.audio.play();
  }

  if (!S.compatible) ctrlSocket._socket.close();

  return S;
});

services.factory('ctrlSocket', function(util, $rootScope) {
  var HEARTBEAT_INTERVAL = 30000; // ms

  var socket = new WebSocket(util.wsUrl('control'));
  var callbacks = {};
  socket.onopen = function() {
    setInterval(function() {
      socket.send(JSON.stringify({'event': 'heartbeat'}));
    }, HEARTBEAT_INTERVAL);
  };
  socket.onmessage = function(evt) {
    var json = JSON.parse(evt.data);
    var event = json.event;
    var data = json.data;
    var from = json.from;
    if (callbacks.hasOwnProperty(event)) $rootScope.$apply(callbacks[event](data, from));
  }
  return {
    on: function(event, cb) {
      callbacks[event] = cb;
    },
    send: function(event, data) {
      socket.send(JSON.stringify({'event':event,'data':data}));
    },
    fwd: function(to, event, data) {
      socket.send(JSON.stringify({'event':'forward','to':to,'data':{'event':event,'data':data}}));
    },
    _socket: socket
  }
});

services.factory('streamSocket', function(util, $rootScope) {
  var socket = new WebSocket(util.wsUrl('stream'));
  var callback;
  socket.binaryType = 'arraybuffer';
  socket.onmessage = function(event) {
    if (callback) $rootScope.$apply(callback(event.data));
  }
  return {
    onChunk: function(cb) {
      callback = cb;
    },
    send: function(data) {
      socket.send(data);
    }
  };
});

services.factory('util', function($window) {
  return {

    trace: function(text) {
      console.log(($window.performance.now() / 1000).toFixed(1) + ': ' + text);
    },

    wsUrl: function(path) {
      var loc = $window.location;
      var new_uri = (loc.protocol === 'https:') ? 'wss:' : 'ws:';
      new_uri += '//' + loc.host +'/' + path;
      return new_uri;
    },

    str2ab: function(str) {
      var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
      var bufView = new Uint16Array(buf);
      for (var i=0, strLen=str.length; i<strLen; i++) {
        bufView[i] = str.charCodeAt(i);
      }
      return buf;
    },

    ab2str: function(ab) {
      return String.fromCharCode.apply(null, new Uint16Array(ab));
    },

    UInt8concat: function(first, second) {
      var firstLength = first.length;
      var result = new Uint8Array(firstLength + second.length);
      result.set(first);
      result.set(second, firstLength);
      return result;
    },

    // hack to increase the upload rate limit
    transformSdp: function(sdp) {
      var splitted = sdp.split('b=AS:30');
      var newSDP = splitted[0] + 'b=AS:1638400' + splitted[1];
      return newSDP;
    }

  }
});