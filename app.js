require("dotenv").config()
const express = require("express")
const app = express()

const connectDB = require("./DB/dataBase")
const flash = require("connect-flash")
const path = require("path") 
const bodyParser = require("body-parser")
const session = require("express-session") 
const nocache = require("nocache") 
const morgan = require("morgan")

connectDB()
const PORT = process.env.PORT || 3000

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

app.use(nocache())


// app.use(morgan('dev'));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {  
        maxAge: 72 * 60 * 60 * 1000,
        httpOnly: true
    }
}))

app.use(flash())

app.set("view engine", "ejs")
app.set("views", [path.join(__dirname, "views/user"), path.join(__dirname, "views/admin")])

app.use(express.static('public'));

app.use(express.static(path.join(__dirname, "public")))
app.use("/public/uploads/product-images",express.static(path.join(__dirname,"public/uploads/product-images")))




const userRoutes = require("./routes/userRouter")
const adminRoutes = require("./routes/adminRouter")

app.use("/", userRoutes)
app.use("/admin", adminRoutes)

app.get('*', function (req, res) {
    res.redirect("/pageNotFound");
    // console.log("here");
});






app.listen(PORT, () => console.log(`Server running on  http://localhost:${PORT}`))