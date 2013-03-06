package stream

import play.api.libs.iteratee._
import reactivemongo.bson._
import reactivemongo.api.gridfs._
import reactivemongo.api._
import scala.concurrent.ExecutionContext
import play.modules.reactivemongo._

object ServerStream {
  import play.api.Play.current
  import play.api.libs.concurrent.Execution.Implicits._
  import reactivemongo.bson.handlers.DefaultBSONHandlers._

  val db = ReactiveMongoPlugin.db
  lazy val gridFS = new GridFS(db, "tracks")
  lazy val chunkCollection = db("tracks.chunks")

  def stream(trackName: String, fromChunk: Int, toChunk: Int) = {
    import reactivemongo.api.gridfs.Implicits._
    val cursor = gridFS.find(BSONDocument("filename" -> BSONString(trackName)))
    Enumerator.flatten(cursor.toList collect {
      case readFile :: _ => enumerate(readFile, chunkCollection, fromChunk, toChunk)
    })
  }

  def getNbChunks(trackName: String) = {
    import reactivemongo.api.gridfs.Implicits._
    val cursor = gridFS.find(BSONDocument("filename" -> BSONString(trackName)))
    cursor.toList collect {
      case readFile :: _ => 
        readFile.length / readFile.chunkSize + (if (readFile.length % readFile.chunkSize > 0) 1 else 0)
    }
  }

  // slight modification of the original GridFS.enumerate method in order to retrieve a serie of chunks (not the whole file)
  private def enumerate(file: ReadFile[_ <: BSONValue], chunks: Collection, from: Int, to: Int): Enumerator[Array[Byte]] = {
    val selector = BSONDocument(
      "$query" -> BSONDocument(
        "files_id" -> file.id,
        "n" -> BSONDocument(
          "$gte" -> BSONInteger(from),
          "$lt" -> BSONInteger(to))),
      "$orderby" -> BSONDocument(
        "n" -> BSONInteger(1)))

    val cursor = chunks.find(selector)
    cursor.enumerate &> (Enumeratee.map { doc =>
      doc.get("data").flatMap {
        case BSONBinary(data, _) => Some(data.array())
        case _ => None
      }.getOrElse {
        throw new RuntimeException("not a chunk! failed assertion: data field is missing")
      }
    })
  }
}