package controllers

import java.nio.charset.Charset
import java.util.UUID
import scala.concurrent._
import scala.concurrent.duration._
import play.api.libs.iteratee.Concurrent.Channel
import play.api.libs.iteratee._
import play.api.libs.json._
import play.api.mvc._
import play.api.Play.current
import play.api.libs.concurrent.Akka
import scala.concurrent.ExecutionContext
import scala.util.Try
import akka.actor.Props
import akka.pattern.ask
import akka.util.Timeout
import akka.actor._
import tracker._
import stream.ServerStream

object Application extends Controller {
  import play.api.libs.concurrent.Execution.Implicits._

  // Akka
  val tracker = Akka.system.actorOf(Props[Tracker], name = "tracker")

  case class TrackMetaInfo(name: String, nbChunk: Long)

  def index = Action {
    // only one track for now
    val trackName = "gangnamstyle.webm"
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
    // new client
    implicit val timeout = Timeout(10 seconds)
    val myId = UUID.randomUUID().toString
    val (out, channel) = Concurrent.broadcast[JsValue]

    val in = (tracker ? NewPeer(myId, channel)).mapTo[ActorRef] map { mySelf =>
      Iteratee.foreach[JsValue] { js =>
        val data = (js \ "data")
        (js \ "event") match {
          
          case (JsString("streamEnded")) =>
            (data \ "trackName").asOpt[String] foreach { tracker ! StreamEnded(_, mySelf) }

          case (JsString("seekPeer")) =>
            (data \ "trackName").asOpt[String] foreach { tracker ! SeekPeer(_, myId) }

          case (JsString("respReqPeer")) =>
            for {
              trackName <- (data \ "trackName").asOpt[String]
              seekId <- (data \ "seekId").asOpt[String]
              seekerId <- (data \ "seekerId").asOpt[String]
            } tracker ! RespReqPeer(seekId, myId, seekerId, trackName)

          case (JsString("forward")) =>
            for {
              to <- (js \ "to").asOpt[String]
              eventToFwd <- (data \ "event").asOpt[String]
              dataToFwd <- (data \ "data").asOpt[JsValue]
            } tracker ! Forward(to, myId, eventToFwd, dataToFwd)

          case (JsString("heartbeat")) =>
            mySelf ! Heartbeat

          case _ =>

        }
      } mapDone { _ => mySelf ! PoisonPill }
    }

    (Iteratee.flatten(in), out)
  }

}