'use strict';

angular.module('ztream.filters', []).
  filter('formatTime', function() {
    return function(time) {
      var m = '' + Math.floor(time / 60);
      var s = '' + Math.floor(time % 60);
      if (m.length === 1) m = '0' + m;
      if (s.length === 1) s = '0' + s;
      return m + ':' + s;
    }
  }).

  filter('percentage', function() {
    return function(ratioTuple, floor) {
      if (floor) {
        return Math.floor((ratioTuple[0]+1)*100/ratioTuple[1]) + ' %';
      }
      else {
        if (ratioTuple[0] === 0) return '0 %'
        else return Math.ceil((ratioTuple[0]+1)*100/ratioTuple[1]) + ' %';
      }
    }
  }).

  filter('NaNTo0', function() {
    return function(value) {
      if (isNaN(value)) return 0
      else return value;
    }
  });