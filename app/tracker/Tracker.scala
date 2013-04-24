package tracker

import scala.concurrent.duration.DurationInt
import akka.actor._
import play.api.Logger
import play.api.libs.iteratee.Concurrent.Channel
import play.api.libs.json._
import java.util.UUID

class Tracker extends Actor {
  import context._

  // map a track name to peers that have entirely streamed it and are still online
  var trackingTable = Map.empty[String, IndexedSeq[ActorRef]]

  // map a "on-going seek event" to the Timeout of this seek event
  var seekIds = Map.empty[String, Cancellable]

  def receive = {

    case NewPeer(id, channel) =>
      val newPeer = actorOf(Props(new Peer(channel)), name = id)
      watch(newPeer)
      sender ! newPeer
      broadcastMonitoringInfo()
      

    case StreamEnded(trackName, peer) =>
      val newTrackingTable = trackingTable.get(trackName) map { peerList =>
        val newPeerList = 
          if (peerList.length < 200) peer +: peerList
          else peer +: peerList.dropRight(1)
        trackingTable + (trackName -> newPeerList)
      } getOrElse {
        trackingTable + (trackName -> IndexedSeq(peer))
      }
      trackingTable = newTrackingTable

    case SeekPeer(trackName, seekerId) =>
      val seeker = actorFor(seekerId)
      val peerNotFound = Json.obj("event" -> "peerNotFound")
      trackingTable.get(trackName) match {
        case None =>
          seeker ! peerNotFound
        case Some(peerList) => 
          val peersToAsk = peerList.take(20) // last 20 streamers still online
          if (peerList.length > 0) {
            val seekId = UUID.randomUUID().toString
            val req = Json.obj(
              "event" -> "reqPeer",
              "data" -> Json.obj(
                "trackName" -> trackName,
                "seekerId" -> seekerId,
                "seekId" -> seekId))
            peersToAsk foreach { peer =>
              peer ! req
            }
            val system = context.system
            import system.dispatcher
            val cancellable = system.scheduler.scheduleOnce(4 seconds) {
              self ! TimeOutSeekPeer(seekId, seeker)
            }
            seekIds = seekIds + (seekId -> cancellable)
          } else {
            seeker ! peerNotFound
          }
      }

    case TimeOutSeekPeer(seekId, seeker) =>
      if (seekIds.contains(seekId)) {
        // send to seeker that no one has been found
        seeker ! Json.obj("event" -> "peerNotFound")
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
        actorFor(seekerId) ! resp
      }

    case Forward(to, from, eventToFwd, dataToFwd) =>
      val messageToFwd = Json.obj("event" -> eventToFwd, "from" -> from, "data" -> dataToFwd)
      actorFor(to) ! messageToFwd


    case Terminated(peerWhoLeft) =>
      Logger.debug("deco from tracker")
      val newTrackingTable = trackingTable mapValues { peerList =>
        peerList filterNot { _ == peerWhoLeft }
      }
      trackingTable = newTrackingTable
      broadcastMonitoringInfo()

    case _ =>
  }

  private def broadcastMonitoringInfo() = {
    val info = Json.obj("event" -> "info", "data" -> Json.obj("peers" -> children.toList.length))
    actorSelection("*") ! info
  }

}

class Peer(channel: Channel[JsValue]) extends Actor {
  import context._

  val heartbeatCheckInterval = 37 seconds
  var alive = true

  override def preStart() = {
    system.scheduler.schedule(1 second, heartbeatCheckInterval, self, CheckHeartbeat)
  }

  def receive = {
    case json: JsValue =>
      channel.push(json) 

    case Heartbeat =>
      alive = true

    case CheckHeartbeat =>
      if (!alive) {
        channel.eofAndEnd()
        stop(self)
      } else {
        alive = false
      }

    case _ =>
  }
  
}

// Messages
case class NewPeer(id: String, channel:Channel[JsValue])
case class StreamEnded(trackName: String, peer: ActorRef)
case class SeekPeer(trackName: String, seekerId: String)
case class RespReqPeer(seekId: String, senderId: String, seekerId: String, trackName: String)
case class Forward(to: String, from: String, eventToFwd: String, dataToFwd: JsValue)
case class TimeOutSeekPeer(seekId: String, seeker: ActorRef)
case object Heartbeat
case object CheckHeartbeat

