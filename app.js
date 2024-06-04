require("dotenv").config()
const express = require("express")
const app = express()
const crypto = require('crypto');
const connectDB = require("./DB/dataBase")
const flash = require("connect-flash")
const path = require("path") 
const bodyParser = require("body-parser")
const session = require("express-session") 
const nocache = require("nocache") 
const morgan = require("morgan")
const Order = require("./models/orderSchema")

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

app.post('/webhooks/razorpay', async (req, res) => {
    const secret = 'mazkingtap'; // Replace with your webhook secret from Razorpay
console.log("its working>>>>>>>>>>>>>")
    // Validate webhook signature
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest === req.headers['x-razorpay-signature']) {
        console.log('Request is legitimate');
        const event = req.body.event;

        if (event === 'payment.authorized') {
            const payment = req.body.payload.payment.entity;
            const order = await Order.findOne({ razorpayOrderId: payment.order_id });
            if (order) {
                order.status = "Confirmed";
                await order.save();
                if (order.product.length > 1) {
                    await User.updateOne({ _id: order.userId }, { $set: { cart: [] } });
                }
            }
        } else if (event === 'payment.failed') {
            const payment = req.body.payload.payment.entity;
            const order = await Order.findOne({ razorpayOrderId: payment.order_id });
            if (order) {
                order.status = "Failed";
                await order.save();
            }
        }
        // Add more event handlers as needed
        res.status(200).json({ status: 'ok' });
    } else {
        console.log('Invalid signature');
        res.status(400).json({ error: 'Invalid signature' });
    }
});



const userRoutes = require("./routes/userRouter")
const adminRoutes = require("./routes/adminRouter")

app.use("/", userRoutes)
app.use("/admin", adminRoutes)

app.get('*', function (req, res) {
    res.redirect("/pageNotFound");
    // console.log("here");
});






app.listen(PORT, () => console.log(`Server running on  http://localhost:${PORT}`))