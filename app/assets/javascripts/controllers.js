'use strict';

angular.module('ztream.controllers', ['ztream.services']).
  controller('DemoCtrl', function($scope, P2Pplayer, $timeout) {
    $scope.P2Pplayer = P2Pplayer;
    var audio = $scope.audio = P2Pplayer.audio;
    $scope.highlight = '';

    $scope.playPause = function() {
      if (P2Pplayer.compatible) {
        if (audio.currentTime === 0 || audio.ended) {
          P2Pplayer.newPlayback();
        } else {
          // play/pause
          if (audio.paused) {
            audio.play();
          } else {
            audio.pause();
          }
        }
      } else {
        $scope.highlight = 'highlight';
        $timeout(function() {
          $scope.highlight = '';
        }, 800);
      }
    }

  });



