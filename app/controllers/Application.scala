package controllers

import java.nio.charset.Charset
import java.util.UUID
import scala.concurrent._
import scala.concurrent.duration._
import akka.actor.Props
import play.api.libs.iteratee.Concurrent.Channel
import play.api.libs.iteratee._
import play.api.libs.json._
import play.api.mvc._
import play.api.Play.current
import play.api.libs.concurrent.Akka
import scala.concurrent.ExecutionContext
import scala.util.Try
import tracker.Tracker._
import stream.ServerStream

object Application extends Controller {
  import play.api.libs.concurrent.Execution.Implicits._

  // Akka
  val tracker = Akka.system.actorOf(Props[Tracker], name = "tracker")

  case class TrackMetaInfo(name: String, nbChunk: Long)

  def index = Action {
    // only one track for now
    val trackName = "gaaTest.webm"
    Async {
      ServerStream.getNbChunks(trackName) map { nbChunk =>
        Ok(views.html.index(TrackMetaInfo(trackName, nbChunk)))
      } recover {
        case _ => Ok(views.html.index(TrackMetaInfo("track not found (error)", 0)))
      }
    }
  }

  // STREAM
  def stream = WebSocket.using[Array[Byte]] { request =>
    // we deal with a binary websocket here (Array[Byte])
    val charset = Charset.forName("UTF-16LE")
    val promiseIn = promise[Iteratee[Array[Byte], Unit]]

    val out = Concurrent.patchPanel[Array[Byte]] { patcher =>

      val in = Iteratee.foreach[Array[Byte]] { bytes =>
        val maybeStream = for {
          json <- Try(Json.parse(new String(bytes, charset))).toOption
          trackName <- (json \ "trackName").asOpt[String]
          fromChunk <- (json \ "from").asOpt[Int]
          toChunk <- (json \ "to").asOpt[Int]
        } yield { 
          ServerStream.stream(trackName, fromChunk, toChunk)
        }
        maybeStream foreach (patcher.patchIn(_))
      }

      promiseIn.success(in)
    }

    (Iteratee.flatten(promiseIn.future), out)
  }

  // CONTROL
  def control = WebSocket.using[JsValue] { request =>
    val id = UUID.randomUUID().toString
    val (out, channel) = Concurrent.broadcast[JsValue]

    val in = Iteratee.foreach[JsValue] { js =>
      val data = (js \ "data")
      (js \ "event") match {
        case (JsString("connect")) =>
          tracker ! Connect(id: String, channel)

        case (JsString("streamEnded")) =>
          (data \ "trackName").asOpt[String] foreach { trackName =>
            tracker ! StreamEnded(trackName, channel)
          }

        case (JsString("seekPeer")) =>
          (data \ "trackName").asOpt[String] foreach { trackName =>
            tracker ! SeekPeer(trackName, channel, id)
          }

        case (JsString("respReqPeer")) =>
          for {
            trackName <- (data \ "trackName").asOpt[String]
            seekId <- (data \ "seekId").asOpt[String]
            seekerId <- (data \ "seekerId").asOpt[String]
          } tracker ! RespReqPeer(seekId, id, seekerId, trackName)

        case (JsString("forward")) =>
          for {
            to <- (js \ "to").asOpt[String]
            eventToFwd <- (data \ "event").asOpt[String]
            dataToFwd <- (data \ "data").asOpt[JsValue]
          } tracker ! Forward(to, from = id, eventToFwd, dataToFwd)

        case (JsString("heartbeat")) =>
          tracker ! Heartbeat(id)

        case _ =>

      }
    } mapDone { _ => tracker ! Disconnect(id, channel) }

    (in, out)
  }

}