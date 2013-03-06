package tracker

import java.util.UUID

import scala.collection.immutable.IndexedSeq
import scala.concurrent.duration.DurationInt

import akka.actor.Actor
import play.api.Logger
import play.api.libs.iteratee.Concurrent.Channel
import play.api.libs.json._

object Tracker {

  class Tracker extends Actor {
    // map trackName to peers' channels that have recently streamed it 
    var trackingTable = Map.empty[String, IndexedSeq[Channel[JsValue]]]

    // map user ID to its channel
    var idToChannel = Map.empty[String, Channel[JsValue]]

    // map of "on-going seek events" IDs in order to have a one-to-any protocol when the tracker seeks for a peer
    var seekIds = Map.empty[String, akka.actor.Cancellable]

    // used for failure detector (websocket heartbeats)
    var maybeDead = Map.empty[String, Channel[JsValue]]

    val system = context.system

    def receive = {
      case Connect(id, channel) =>
        idToChannel = idToChannel + (id -> channel)
        sendMonitoringInfo()

      case StreamEnded(trackName, channel) =>
        val newTrackingTable = trackingTable.get(trackName) map { peerList =>
          val newPeerList = { 
            if (peerList.length < 20) channel +: peerList      
            else channel +: peerList.dropRight(1)
          }
          trackingTable + (trackName -> newPeerList)
        } getOrElse {
          trackingTable + (trackName -> IndexedSeq(channel))
        }
        trackingTable = newTrackingTable

      case SeekPeer(trackName, seekerChannel, seekerId) =>
        val peerNotFound = Json.obj("event" -> "peerNotFound")
        trackingTable.get(trackName) match {
          case None =>
            seekerChannel.push(peerNotFound)
          case Some(peerList) => 
            if (peerList.length > 0) {
              val seekId = UUID.randomUUID().toString
              val req = Json.obj(
                "event" -> "reqPeer",
                "data" -> Json.obj(
                  "trackName" -> trackName,
                  "seekerId" -> seekerId,
                  "seekId" -> seekId))
              peerList foreach { channel =>
                channel.push(req)
              }
              val system = context.system
              import system.dispatcher
              val cancellable = system.scheduler.scheduleOnce(4 seconds) {
                self ! TimeOutSeekPeer(seekId, seekerChannel)
              }
              seekIds = seekIds + (seekId -> cancellable)
            } else {
              seekerChannel.push(peerNotFound)
            }
        }

      case TimeOutSeekPeer(seekId, seekerChannel) =>
        if (seekIds.contains(seekId)) {
          // send to seeker that no one has been found
          seekerChannel.push(Json.obj("event" -> "peerNotFound"))
          seekIds = seekIds - seekId
        }

      case RespReqPeer(seekId, senderId, seekerId, trackName) =>
        seekIds.get(seekId) foreach { cancellable =>
          // senderChannel is the first peer to respond to the one-to-any req
          cancellable.cancel()
          seekIds = seekIds - seekId
          val resp = Json.obj(
            "event" -> "peerFound",
            "data" -> Json.obj(
              "trackName" -> trackName,
              "seederId" -> senderId))
          idToChannel.get(seekerId) foreach { _.push(resp) }
        }

      case Forward(to, from, eventToFwd, dataToFwd) =>
        val json = Json.obj("event" -> eventToFwd, "from" -> from, "data" -> dataToFwd)
        idToChannel.get(to) foreach { _.push(json) }

      case Disconnect(id, channel) =>
        // removing all the references of channel
        Logger.debug("deco from tracker")
        val newTrackingTable = trackingTable mapValues { peerList =>
          peerList filterNot { _ eq channel }
        }
        trackingTable = newTrackingTable
        idToChannel = idToChannel - id
        sendMonitoringInfo()

      case Heartbeat(id) =>
        maybeDead = maybeDead - id

      case CheckHeartbeat =>
        maybeDead foreach { case(id, channel) => 
            channel.eofAndEnd
            self ! Disconnect(id, channel)
        }
        Logger.debug("checkheart beat: number of dead: " + maybeDead.size)
        maybeDead = idToChannel

      case _ =>
    }

    override def preStart() = {
      import system.dispatcher
      system.scheduler.schedule(16 seconds, 16 seconds, self, CheckHeartbeat)
    }

    def sendMonitoringInfo() = {
      val info = Json.obj("event" -> "info", "data" -> Json.obj("peers" -> idToChannel.size))
      idToChannel foreach { case (_, channel) => channel.push(info) }
    }

  }

  // Messages
  case class Connect(id: String, channel: Channel[JsValue])
  case class StreamEnded(trackName: String, channel: Channel[JsValue])
  case class SeekPeer(trackName: String, seekerChannel: Channel[JsValue], seekerId: String)
  case class Disconnect(id: String, channel: Channel[JsValue])
  case class RespReqPeer(seekId: String, senderId: String, seekerId: String, trackName: String)
  case class Forward(to: String, from: String, eventToFwd: String, dataToFwd: JsValue)
  case class TimeOutSeekPeer(seekId: String, seekerChannel: Channel[JsValue])
  case class Heartbeat(id: String)
  case object CheckHeartbeat

}

