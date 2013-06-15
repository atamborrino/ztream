define(["vendor/jquery"], function($) {

  return {

    formatTime: function(time) {
      var m = ""+Math.floor(time / 60);
      var s = ""+Math.floor(time % 60);
      if (m.length === 1)
        m = "0"+m;
      if (s.length === 1)
        s = "0"+s;
      return m+":"+s;
    },

    trace: function(text) {
      performance.now = performance.now || performance.webkitNow;
      var log = (performance.now() / 1000).toFixed(1) + ": " + text;
      console.log(log);
      $("#log>textarea").text((log+"\n"+$("#log>textarea").text()).substring(0,20000));
    },

    wsUrl: function(path) {
      var loc = window.location;
      var new_uri = (loc.protocol === "https:") ? "wss:" : "ws:";
      new_uri += "//" + loc.host +"/" + path;
      return new_uri;
    },

    mess: function(event,data) {
      this.trace("Send: "+JSON.stringify({"event:":event,"data":data}));
      return JSON.stringify({"event":event,"data":data});
    },

    fwdMess: function(to,event,data) {
      //this.trace("Send to peer"+to+": "+JSON.stringify({"event:":event,"data":data}));
      return JSON.stringify({"event":"forward","to":to,"data":{"event":event,"data":data}});
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
      var splitted = sdp.split("b=AS:30");
      var newSDP = splitted[0] + "b=AS:1638400" + splitted[1];
      return newSDP;
    }

  }

});