import play.api._
import reactivemongo.api._
import reactivemongo.bson._
import reactivemongo.bson.handlers.DefaultBSONHandlers._
import play.modules.reactivemongo._
import play.api.Play.current
import play.api.libs.iteratee.Enumerator
import reactivemongo.api.gridfs._
import play.api.libs.json.Json
import scala.concurrent.future
import play.api.libs.concurrent.Execution.Implicits._
import scala.concurrent.Future
import scala.concurrent.duration._
import play.api.Play
import reactivemongo.api.gridfs.Implicits._

object Global extends GlobalSettings {

  override def onStart(app: Application) {
    if (Play.isDev) {
      implicit val timeout = 5 seconds
      val db = ReactiveMongoPlugin.db
      val gridFS = new GridFS(db, "tracks")

      val trackToAdd = "gaaTest.webm"
      val CHUNK_SIZE = 256
      val contentType = "application/octet-stream"
      val enumFile = Enumerator.fromFile(Play.getFile("public/sounds/" + trackToAdd))

      for {
        _ <- gridFS.files.remove(BSONDocument())
        _ <- gridFS.chunks.remove(BSONDocument())
        newReadFile <- gridFS.save(enumFile, DefaultFileToSave(trackToAdd, Some(contentType)), CHUNK_SIZE)
      } yield {
        Logger.info("Mongo cleaned, new track added")
        newReadFile
      }

    }
  }
}