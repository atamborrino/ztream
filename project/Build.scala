import sbt._
import Keys._
import play.Project._

object ApplicationBuild extends Build {

  val appName         = "Ztream"
  val appVersion      = "1.1"

  val appDependencies = Seq(
    // Add your project dependencies here,
    "org.reactivemongo" %% "play2-reactivemongo" % "0.8"
  )


  val main = play.Project(appName, appVersion, appDependencies).settings(
    // Add your own project settings here      
    requireJs += "main.js",
    requireJsShim += "main.js"
  )

}