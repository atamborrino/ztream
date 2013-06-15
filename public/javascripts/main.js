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

require(['helper/util','vendor/base64', 'vendor/jquery'], function(u, base64, $) { 
  'use strict';

  // STUN server
  var SERVER = 'stun:stun.l.google.com:19302';

  // Check compatibilty
  var RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
  var MediaSource = window.MediaSource || window.WebKitMediaSource || window.mozMediaSource;
  var compatible = false;
  var pc;
  try {
    if (RTCPeerConnection && MediaSource) {
      pc = new RTCPeerConnection({'iceServers': [{'url': SERVER}]},{ optional:[ { RtpDataChannels: true }]});
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
  if (!compatible) {
    $('#not-compatible').removeClass('hidden');
    $('#totalNumberPeers').text('-');
  }

  // Map of peerId -> peerConnection
  var peers = {};
  var MAX_LEECHERS_PER_SEEDER = 2;

  var seederConn, seedChan; // peer connection and data channel
  var trackName = $('#trackName').text();
  var totalNbChunk = parseInt($('#totalNbChunk').text(),10);
  var track = []; // array of chunks (in-memory cache)

  // Audio
  var audio = document.createElement('video'); // <audio> does not support Media Source API yet
  var mediaSource, sourceBuffer;

  // streaming from server
  var CHUNK_WINDOW = 700; // number of chunks we ask to server each time we need to
  var chunkNbInsideWindow = -1; // higher chunk number received inside the current chunk window streamed from server

  var HEARTBEAT_INTERVAL = 30000; // ms
  var MIN_BUFFER_TIME = 4; // min ahead time (seconds) authorized for the buffer. If less, we go in emergency mode.

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
    seedChan = seederConn.createDataChannel(trackName, {reliable : true});
    seedChan.binaryType = 'arraybuffer';
    // u.trace('Going to open DataChannel');

    seedChan.onopen = function() {
      u.trace('DataChannel opened');
      if (!emergencyMode) {
        u.trace('Sending P2P stream request');
        seedChan.send(JSON.stringify({'from':track.length}));
      }
    };

    seedChan.onmessage = function(evt) {
      seederIsSuspected = false;
      if (!emergencyMode) {
        var binaryData = base64.decode(evt.data);
        var chunkNum = new Uint32Array(binaryData.slice(0,4))[0];
        // u.trace('P2P: rcv: chunk '+chunkNum);
        if (chunkNum === track.length) {
          var chunk = binaryData.slice(4);
          track.push(chunk);
          chunkFromPeers +=1;
          $('#chunkN').text(track.length);
          $('#percentagePeers').text(Math.ceil((chunkFromPeers+1)*100/totalNbChunk));
          appendToPlayback(chunk);

          if (streamEnded()){
            ctrlSocket.send(u.mess('streamEnded',{'trackName':trackName}));
            mediaSource.endOfStream();
            $('#totalTime').text(u.formatTime(audio.duration)); // hack, should not be needed
          }
        } else {
          // u.trace('rcv chunk from P2P but wrong number');
        }
      } else {
        // u.trace('rcv chunk from P2P but emergency mode');
        // ignoring chunk (it arrived too late!)
        // TODO: implement 'stop' message ?
      }
    };

    seedChan.onclose = function() {
      // Peer have closed the connection before the seeker have downloaded the full track
      if (seederConn) { // == if we have not suspected the seeder before (onclose can be delayed)
        u.trace('data channel closed');
        seedChan = null;
        try {
          seederConn.close();
        } catch(err) {}
        seederConn = null;
        seederIsSuspected = false;
        $('#connectedToSeeder').text(false);
      }
    }

    $('#connectedToSeeder').text(true);
  }

  // seeder side
  function onP2PstreamRequest(evt) { 
    u.trace('DataChannel opened');
    var chan = evt.channel;
    chan.binaryType = 'arraybuffer';
    var trackWanted = chan.label;
    var cancellable;

    chan.onmessage = function (evt) {
      u.trace('Receiving P2P stream request');
      var req = JSON.parse(evt.data);
      if (cancellable) {
        // cancelling previous sending
        clearInterval(cancellable);
      } else {
        nbCurrentLeechers += 1;
      }
      var chunkI = req.from;
      $('#nbLeechers').text(nbCurrentLeechers);

      function sendProgressively() {
        // goal rate: 75 kb/s
        for(var i = 0; chunkI < track.length && i < 150; i++) {
          var chunkNum = new Uint32Array(1);
          chunkNum[0] = chunkI;
          var chunkNumInt8 = new Uint8Array(chunkNum.buffer);
          var chunk = u.UInt8concat(chunkNumInt8, new Uint8Array(track[chunkI])).buffer;
          var b64encoded = base64.encode(chunk);
          chan.send(b64encoded);
          chunkI++;
          // u.trace('P2P: send chunk '+chunkI);
        }
        if (chunkI >= track.length) {
          clearInterval(cancellable);
          cancellable = null;
          nbCurrentLeechers -= 1;
          $('#nbLeechers').text(nbCurrentLeechers);
        }
      }
      sendProgressively();
      cancellable = setInterval(sendProgressively, 1000);
    };

    chan.onclose = function () {
      u.trace('datachannel closed');
      nbCurrentLeechers -= 1;
      $('#nbLeechers').text(nbCurrentLeechers);
    };

  }

  function streamFromServer(fromChunkN,toChunkN) {
    // enter server streaming mode
    if (chunkNbInsideWindow === -1) { // no other concurrent requests
      chunkNbInsideWindow = 0;
      emergencyMode = true;
      var req = {'trackName':trackName,'from':fromChunkN,'to':toChunkN};
      u.trace("Request to server: " + JSON.stringify(req));
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
      ctrlSocket.send(u.mess('seekPeer',{'trackName':trackName}));
      // u.trace('SEEK NEW PEER');
      peerRequested = true;
    }
  }

  function streamEnded() {
    return (track.length >= totalNbChunk);
  }


  // Webscocket connections
  if (compatible) {
    var ctrlSocket = new WebSocket(u.wsUrl('control')); 
    var streamSocket = new WebSocket(u.wsUrl('stream'));
    streamSocket.binaryType = 'arraybuffer';

    // control events
    ctrlSocket.onopen = function() {
      setInterval(function() {
        ctrlSocket.send(u.mess('heartbeat',{}));
      }, HEARTBEAT_INTERVAL);
    };
    ctrlSocket.onmessage = function(evt) {
      var json = JSON.parse(evt.data);
      var event = json.event;
      var data = json.data;
      var from = json.from;

      if (event === 'reqPeer') {
        var trackWanted = data.trackName;
        // testing if we have the track and if we dont stream to too many peers yet
        if (trackWanted === trackName && track.length === totalNbChunk && nbCurrentLeechers < MAX_LEECHERS_PER_SEEDER) {
          // ok
          ctrlSocket.send(u.mess('respReqPeer',
            {'trackName':trackWanted,'seekId':data.seekId,'seekerId':data.seekerId}));
        }
      }

      else if (event === 'peerNotFound') {
        peerRequested = false;
        u.trace('peer not found');
      }

      else if (event === 'info') {
        $('#totalNumberPeers').text(data.peers);
      }

      // WebRTC caller side (leecher)
      else if (event === 'peerFound') {
        peerRequested = false;
        if (!seederConn) {
          var seederId = data.seederId;
          seederConn = new RTCPeerConnection({'iceServers': [{'url': SERVER}]},{ optional:[ { RtpDataChannels: true }]});
          u.trace('establishing P2P connection caller side (leecher)');

          seederConn.onicecandidate = function(iceEvt) {
            if (iceEvt.candidate) {
              ctrlSocket.send(u.fwdMess(seederId,'callerIceCandidate', {'candidate': iceEvt.candidate }));
            }
          };
          seederConn.onnegotiationneeded = function() {
            seederConn.createOffer(function(desc){
              seederConn.setLocalDescription(desc, function() {
                desc.sdp = u.transformSdp(desc.sdp);
                ctrlSocket.send(u.fwdMess(seederId,'rtcOffer', {'sdp': desc}));
              });
            });
          };

          P2PstreamRequest(seederConn);
        }
      }

      // WebRTC callee side (seeder)
      else if (event === 'rtcOffer' || event === 'callerIceCandidate') {
        var leecherId = from;
        if (!peers.hasOwnProperty(leecherId)) {
          //creation of new P2P connection
          var leecherConn = new RTCPeerConnection({'iceServers': [{'url': SERVER}]},
            { optional:[ { RtpDataChannels: true } ]});

          leecherConn.onicecandidate = function(iceEvt) {
            if (iceEvt.candidate) {
              ctrlSocket.send(u.fwdMess(leecherId,'calleeIceCandidate', {'candidate': iceEvt.candidate }));
            }
          };

          leecherConn.ondatachannel = function(evt) { onP2PstreamRequest(evt); };
          peers[leecherId] = leecherConn;
        }

        var leecherConn = peers[leecherId];
        if (event === 'rtcOffer') {
          leecherConn.setRemoteDescription(new RTCSessionDescription(data.sdp), function() {
            // u.trace('rtc offer set'); 
            leecherConn.createAnswer(function(desc){
              desc.sdp = u.transformSdp(desc.sdp);
              leecherConn.setLocalDescription(desc, function() {
                ctrlSocket.send(u.fwdMess(leecherId,'rtcAnswer', {'sdp': desc }));
              });
            });
          });
        }
        else if (event === 'callerIceCandidate') {
          leecherConn.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      }

      // WebRTC caller side (leecher)
      else if (event === 'rtcAnswer' && seederConn) {
        seederConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
      }

      // WebRTC caller side (leecher)
      else if (event === 'calleeIceCandidate' && seederConn) {
        seederConn.addIceCandidate(new RTCIceCandidate(data.candidate));
      }

    };


    // stream
    streamSocket.onmessage = function (event) {
      var chunk = event.data;
      track.push(chunk);
      appendToPlayback(chunk);
      chunkNbInsideWindow += 1;
      chunkFromServer += 1;

      $('#chunkN').text(track.length);
      $('#percentageServer').text(Math.floor((chunkFromServer+1)*100/totalNbChunk));

      if (streamEnded()){
        chunkNbInsideWindow = -1;
        ctrlSocket.send(u.mess('streamEnded',{'trackName':trackName}));
        emergencyMode = false;
        mediaSource.endOfStream();
        $('#totalTime').text(u.formatTime(audio.duration)); // hack, should not be needed
      } else if (chunkNbInsideWindow >= CHUNK_WINDOW) {
        // end of the stream response of CHUNK_WINDOW chunks
        chunkNbInsideWindow = -1;
        emergencyMode = false;
        // recontact seeder to ask for chunks
        if (seedChan && seedChan.readyState === 'open') {
          if (seederIsSuspected) {
            u.trace('seeder is inactive');
            seedChan.close();
            seederConn.close();
            seedChan = null;
            seederConn = null;
            seederIsSuspected = false;
            $('#connectedToSeeder').text(false);
            seekPeer();
          } else {
            u.trace('Sending P2P stream request from '+track.length);
            seedChan.send(JSON.stringify({'from':track.length}));
            seederIsSuspected = true;
          }
        } else {
          seekPeer();
        }
      }
    }
    
  }


  // user event
  $('#playButton').click(function() {
    if (!compatible) {
      $('.warning').fadeTo(250,0.01).fadeTo(250,1);
    } else {
      if (audio.currentTime === 0 || audio.ended) {
        // new playback of the track
        mediaSource = new MediaSource();
        audio.src = window.URL.createObjectURL(mediaSource);
        audio.load();

        audio.addEventListener('canplay', function() {
          $('#totalTime').text(u.formatTime(audio.duration));
        }, false);

        audio.addEventListener('timeupdate', function() {
          // setting emergency streaming from server if there is less
          // than 3 seconds until the end of the buffer
          if (isEmergencyMode()) {
            streamFromServer(track.length,track.length+CHUNK_WINDOW);
          }
          $('#currentTime').text(u.formatTime(audio.currentTime));
        }, false);

        audio.addEventListener('ended', function(){
          $('#playButton').attr('src','assets/images/play.png');
          if ($('#fromCache').length === 0) {
            $('#playButton').after('<span id="fromCache">from cache</span>');
          }
        }, false);

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
          
          if (track.length < totalNbChunk) {
            seekPeer();
          }
        }, false);

        audio.play();
        $('#playButton').attr('src','assets/images/pause.png');

      } else {
        // play/pause
        if (audio.paused){
          $('#playButton').attr('src','assets/images/pause.png');
          audio.play();
        } else {
          $('#playButton').attr('src','assets/images/play.png');
          audio.pause();
        }
      } 
    }
    return false;
  });

});