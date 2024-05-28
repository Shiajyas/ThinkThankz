const User = require("../models/userSchema")
const Product = require("../models/productSchema")
const Address = require("../models/addressSchema")
const Order = require("../models/orderSchema")
const Return = require("../models/returnSchema")
const Coupon = require("../models/couponSchema")
const invoice = require("../helpers/invoice")
const mongodb = require("mongodb")
const razorpay = require("razorpay")
const crypto = require("crypto");


let instance = new razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
})


const getCheckoutPage = async (req, res) => {
    try {
        console.log("queryyyyyyyy", req.query);
        if (req.query.isSingle == "true") {
            const id = req.query.id
            const findProduct = await Product.find({ id: id }).lean()
            const userId = req.session.user
            const findUser = await User.findOne({ _id: userId })
            const addressData = await Address.findOne({ userId: userId })
            // console.log(addressData)
            console.log("THis is find product =>", findProduct);

            const today = new Date().toISOString(); // Get today's date in ISO format

            const findCoupons = await Coupon.find({
                isList: true,
                createdOn: { $lt: new Date(today) },
                expireOn: { $gt: new Date(today) },
                minimumPrice: { $lt: findProduct[0].salePrice },
            });


            console.log(findCoupons, 'this is coupon ');

            res.render("checkout", { product: findProduct, user: userId, findUser: findUser, userAddress: addressData, isSingle: true, coupons: findCoupons })
        } else {
            const user = req.query.userId
            const findUser = await User.findOne({ _id: user })
            // console.log(findUser);
            // const productIds = findUser.cart.map(item => item.productId)
            // console.log(productIds)
            // const findProducts = await Product.find({ _id: { $in: productIds } })
            // console.log(findProducts);
            const addressData = await Address.findOne({ userId: user })
            // console.log("THis is find product =>",findProducts);
            const oid = new mongodb.ObjectId(user);
            const data = await User.aggregate([
                { $match: { _id: oid } },
                { $unwind: "$cart" },
                {
                    $project: {
                        proId: { '$toObjectId': '$cart.productId' },
                        quantity: "$cart.quantity"
                    }
                },
                {
                    $lookup: {
                        from: 'products',
                        localField: 'proId',
                        foreignField: '_id',
                        as: 'productDetails'
                    }
                },
            ])

            // console.log("Data  =>>", data)
            // console.log("Data  =>>" , data[0].productDetails[0])
            const grandTotal = req.session.grandTotal
            // console.log(grandTotal);
            const today = new Date().toISOString(); // Get today's date in ISO format

            const findCoupons = await Coupon.find({
                isList: true,
                createdOn: { $lt: new Date(today) },
                expireOn: { $gt: new Date(today) },
                minimumPrice: { $lt: grandTotal },
            });

            res.render("checkout", { data: data, user: findUser, isCart: true, userAddress: addressData, isSingle: false, grandTotal, coupons: findCoupons })
        }

    } catch (error) {
        console.log(error.message);
    }
}


const orderPlaced = async (req, res) => {
    try {
        console.log("req.body================>", req.body);
        if (req.body.isSingle === "true") {
            const { totalPrice, addressId, payment, productId } = req.body
            const userId = req.session.user
            console.log(req.session.grandTotal,"from session");
            const grandTotal = req.session.grandTotal
            const couponDiscount = req.session.coupon
            // console.log(req.body)
            // console.log(totalPrice, addressId, payment, productId);
            const findUser = await User.findOne({ _id: userId })
            // console.log("Find user ===>", findUser);
            const address = await Address.findOne({ userId: userId })
            // console.log(address);
            // const findAddress = address.find(item => item._id.toString() === addressId);
            const findAddress = address.address.find(item => item._id.toString() === addressId);
            console.log(findAddress);
            // console.log("Before product search")
            const findProduct = await Product.findOne({ _id: productId })
            // console.log(findProduct);
           

            const productDetails = {
                _id: findProduct._id,
                price: findProduct.salePrice,
                name: findProduct.productName,
                image: findProduct.productImage[0],
                productOffer: findProduct.regularPrice - findProduct.salePrice, 
                quantity: 1
            }
            // console.log("Before order placed")
            const newOrder = new Order(({
                product: productDetails,
                totalPrice: req.body.totalPrice,
                address: findAddress,
                payment: payment,
                userId: userId,
                couponDiscount: couponDiscount,
                createdOn: Date.now(),
                status: "Confirmed",
            }))

          
            console.log("Order placed")
            findProduct.quantity = findProduct.quantity - 1

            


            let orderDone; 

            if (newOrder.payment == 'cod') {
                console.log('Order Placed with COD');
                await findProduct.save()
                orderDone = await newOrder.save();
                res.json({ payment: true, method: "cod", order: orderDone, quantity: 1, orderId: userId });
            } else if (newOrder.payment == 'online') {
                console.log('order placed by Razorpay');
                orderDone = await newOrder.save();
                const generatedOrder = await generateOrderRazorpay(orderDone._id, orderDone.totalPrice);
                console.log(generatedOrder, "order generated");
                await findProduct.save()
                res.json({ payment: false, method: "online", razorpayOrder: generatedOrder, order: orderDone, orderId: orderDone._id, quantity: 1 });
            } else if (newOrder.payment == "wallet") {
                if (newOrder.totalPrice <= findUser.wallet) {
                    console.log("order placed with Wallet");
                    const data = findUser.wallet -= newOrder.totalPrice;
                    const newHistory = {
                        amount: data,
                        status: "debit",
                        date: Date.now()
                    };
                    findUser.history.push(newHistory);
                    await findUser.save();
                    await findProduct.save()
                    orderDone = await newOrder.save();
            
                    res.json({ payment: true, method: "wallet", order: orderDone, orderId: orderDone._id, quantity: 1, success: true });
                    return;
                } else {
                    console.log("wallet amount is lesser than total amount");
                    res.json({ payment: false, method: "wallet", success: false });
                    return;
                }
            }

        } else {

            console.log("from cart");

            const { totalPrice, addressId, payment } = req.body
            // console.log(totalPrice, addressId, payment);
            const userId = req.session.user
            const findUser = await User.findOne({ _id: userId })
            const productIds = findUser.cart.map(item => item.productId)
            const grandTotal = req.session.grandTotal
            console.log(grandTotal, "grandTotal");
            //  const addres= await Address.find({userId:userId})

            const findAddress = await Address.findOne({ 'address._id': addressId });

            if (findAddress) {
                const desiredAddress = findAddress.address.find(item => item._id.toString() === addressId.toString());
                // console.log(desiredAddress);


                const findProducts = await Product.find({ _id: { $in: productIds } })
               
                if (findProducts && Array.isArray(findProducts.salePrice)) {
                    const total = findProducts.salePrice.reduce((acc, curr) => acc + curr, 0);
                    console.log(total);
                } else {
                    console.log('Product not found or slarPrice is not an array');
                }

                const cartItemQuantities = findUser.cart.map((item) => ({
                    productId: item.productId,
                    quantity: item.quantity
                }))

                const orderedProducts = findProducts.map((item) => ({
                    _id: item._id,
                    price: item.salePrice,
                    regularPrice: item.regularPrice,
                    name: item.productName,
                    productOffer: item.regularPrice - item.salePrice, 
                    image: item.productImage[0],
                    quantity: cartItemQuantities.find(cartItem => cartItem.productId.toString() === item._id.toString()).quantity
                }))




                const newOrder = new Order({
                    product: orderedProducts,
                    totalPrice: req.body.totalPrice,
                    address: desiredAddress,
                    payment: payment,
                    userId: userId,
                    couponDiscount: req.session.coupon,
                    status: "Confirmed",
                    createdOn: Date.now()

                })
                

                await User.updateOne(
                    { _id: userId }, 
                    { $set: { cart: [] } }
                );


                // console.log('thsi is new order',newOrder);

                for (let i = 0; i < orderedProducts.length; i++) {

                    const product = await Product.findOne({ _id: orderedProducts[i]._id });
                    if (product) {
                        const newQuantity = product.quantity - orderedProducts[i].quantity;
                        product.quantity = Math.max(newQuantity, 0);
                        await product.save();
                    }
                }
                
                let orderDone
                if (newOrder.payment == 'cod') {
                    console.log('order placed by cod');
                    orderDone = await newOrder.save();
                    res.json({ payment: true, method: "cod", order: orderDone, quantity: cartItemQuantities, orderId: findUser });
                } else if (newOrder.payment == 'online') {
                    console.log('order placed by Razorpay');
                    orderDone = await newOrder.save();
                    const generatedOrder = await generateOrderRazorpay(orderDone._id, orderDone.totalPrice);
                    console.log(generatedOrder, "order generated");
                    res.json({ payment: false, method: "online", razorpayOrder: generatedOrder, order: orderDone, orderId: orderDone._id, quantity: cartItemQuantities });
                } else if (newOrder.payment == "wallet") {
                    if (newOrder.totalPrice <= findUser.wallet) {
                        console.log("order placed with Wallet");
                        const data = findUser.wallet -= newOrder.totalPrice
                        const newHistory = {
                            amount: data,
                            status: "debit",
                            date: Date.now()
                        }
                        findUser.history.push(newHistory)
                        await findUser.save()

                        orderDone = await newOrder.save();

                        res.json({ payment: true, method: "wallet", order: orderDone, orderId: orderDone._id, quantity: cartItemQuantities, success: true })
                        return;
                    } else {
                        console.log("wallet amount is lesser than total amount");
                        res.json({ payment: false, method: "wallet", success: false });
                        return
                    }
                }

            } else {
                console.log('Address not found');
            }
        }
    } catch (error) {
        console.log(error.message);
    }
}



const generateOrderRazorpay = (orderId, total) => {
    return new Promise((resolve, reject) => {
        const options = {
            amount: total * 100,
            currency: "INR",
            receipt: String(orderId)
        };
        instance.orders.create(options, function (err, order) {
            if (err) {
                console.log("failed");
                console.log(err);
                reject(err);
            } else {
                console.log("Order Generated RazorPAY: " + JSON.stringify(order));
                resolve(order);
            }
        });
    })
}



const getOrderListPageAdmin = async (req, res) => {
    try {
        const orders = await Order.find({}).sort({ createdOn: -1 });

        // console.log(req.query);

        let itemsPerPage = 5
        let currentPage = parseInt(req.query.page) || 1
        let startIndex = (currentPage - 1) * itemsPerPage
        let endIndex = startIndex + itemsPerPage
        let totalPages = Math.ceil(orders.length / 3)
        const currentOrder = orders.slice(startIndex, endIndex)

        res.render("orders-list", { orders: currentOrder, totalPages, currentPage })
    } catch (error) {
        console.log(error.message);
    }
}


const cancelOrder = async (req, res) => {
    try {
        console.log("im here");
        const userId = req.session.user
        const findUser = await User.findOne({ _id: userId })

        if (!findUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const orderId = req.query.orderId
        // console.log(orderId,1);

        await Order.updateOne({ _id: orderId },
            { status: "Canceled" }
        ).then((data) => console.log(data))

        const findOrder = await Order.findOne({ _id: orderId })

        if (findOrder.payment === "wallet" || findOrder.payment === "online") {
            findUser.wallet += findOrder.totalPrice;
            findOrder.totalPrice = 0
            const newHistory = {
                amount: findOrder.totalPrice,
                status: "credit",
                date: Date.now()
            }
            findUser.history.push(newHistory)
            await findUser.save();
        }

        console.log(findOrder,2);

        for (const productData of findOrder.product) {
            const productId = productData._id;
            const quantity = productData.quantity;
            console.log(productId, "=>>>>>>>>>");
            const product = await Product.findById(productId);

            console.log(product, "=>>>>>>>>>");

            if (product) {
                product.quantity += quantity;
                await product.save();
            }
        }

        res.redirect('/profile');

    } catch (error) {
        console.log(error.message);
    }
}






const changeOrderStatus = async (req, res) => {
    try {
        console.log(req.query);


        const orderId = req.query.orderId
        console.log(orderId);

        await Order.updateOne({ _id: orderId },
            { status: req.query.status }
        ).then((data) => console.log(data))

        // const findOrder = await Order.findOne({ _id: orderId })

        // console.log(findOrder,"order......................");

        res.redirect('/admin/orderList');

    } catch (error) {
        console.log(error.message);
    }
}


const getCartCheckoutPage = async (req, res) => {
    try {
        res.render("checkoutCart")
    } catch (error) {
        console.log(error.message);
    }
}

const getOrderDetailsPage = async (req, res) => {
    try {
        const userId = req.session.user;
        const orderId = req.query.id;
        
        console.log('Received orderId:', orderId);
        console.log('Received userId:', userId);

        const findOrder = await Order.findOne({ _id: orderId });
        const findUser = await User.findOne({ _id: userId });

        console.log('Order found:', findOrder);
        console.log('User found:', findUser);

        const returnRequests = await Return.find({ orderId: orderId }).populate('productId').sort({ createdAt: -1 });

        res.render("orderDetails", { orders: findOrder, user: findUser, returnRequests });
    } catch (error) {
        console.error('Error occurred:', error.message);
        res.status(500).send('Internal Server Error');
    }
};


const getOrderDetailsPageAdmin = async (req, res) => {
    try {
        const orderId = req.query.id;
        const findOrder = await Order.findOne({ _id: orderId }).sort({ createdOn: 1 });

        if (!findOrder) {
            console.error("findOrder is null or undefined");
            return res.status(404).render("error", { message: "Order not found" });
        }

        let products = findOrder.product;
        let productDetailsList = [];
        let coupons = [];

        if (Array.isArray(products)) {
            const userId = findOrder.userId;
            coupons = await Coupon.find({ userId: userId });

            for (const product of products) {
                if (product._id) {
                    try {
                        const productDetails = await Product.findById(product._id).lean();
                        if (productDetails) {
                            let originalPrice = productDetails.salePrice;

                                if (originalPrice === undefined) {
                                console.error(`Product with ID ${product._id} does not have a salePrice field`);
                                continue;
                            }

                            let salePrice = productDetails.salePrice;
                            let offerPrice = 0; // Initialize offerPrice to 0

                            const applicableCoupon = coupons.find(coupon => coupon.userId.includes(userId));
                            if (applicableCoupon) {
                                offerPrice += applicableCoupon.offerPrice;
                            }

                            let totalPrice = findOrder.totalPrice;

                            productDetailsList.push({
                                ...productDetails,
                                quantity: product.quantity,
                                totalPrice: parseFloat(totalPrice),
                                offerPrice: parseFloat(offerPrice)
                            });

                            console.log("Product ID:", product._id);
                            console.log("Original sale price:", productDetails.salePrice);
                            console.log("Coupon offer price:", applicableCoupon ? applicableCoupon.offerPrice : 0);
                            console.log("Total offer price:", offerPrice);
                            console.log("Final sale price:", salePrice);
                        } else {
                            console.error(`No product found with _id: ${product._id}`);
                        }
                    } catch (error) {
                        console.error(`Failed to find product with _id: ${product._id}`, error);
                    }
                } else {
                    console.error(`Product does not have an _id field`);
                }
            }
        } else {
            console.error("products is not an array");
        }

        const returnRequests = await Return.find({ orderId: orderId })
            .populate('userId')
            .populate('productId');

        res.render("order-details-admin", {
            orders: findOrder,
            orderId,
            returnRequests,
            productDetailsList,
            coupons
        });
    } catch (error) {
        console.log(error.message);
    }
};


const verify = (req, res) => {
    console.log(req.body,"end");
    let hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
    hmac.update(
        `${req.body.payment.razorpay_order_id}|${req.body.payment.razorpay_payment_id}`
    );
    hmac = hmac.digest("hex");
    // console.log(hmac,"HMAC");
    // console.log(req.body.payment.razorpay_signature,"signature");
    if (hmac === req.body.payment.razorpay_signature) {
        console.log("true");
        res.json({ status: true });
    } else {
        console.log("false");
        res.json({ status: false });
    }
};


const getInvoice = async (req, res) => {
    try {
        console.log("helloooo");
        await invoice.invoice(req, res);
    } catch (error) {
        console.log(error.message);
    }
}

const cancelProduct = async (req, res) => {
    try {
        const userId = req.session.user;
        const findUser = await User.findOne({ _id: userId });

        if (!findUser) {
            return res.status(404).json({ message: 'User not found' });
        }

        const { productId, orderId, cancelQuantity } = req.body;

        console.log(req.body)

        if (!productId || !orderId || !cancelQuantity || productId.length === 0 || orderId.length === 0 || cancelQuantity.length === 0) {
            return res.status(400).json({ message: 'Invalid request data' });
        }

        const currentProductId = productId[0];
        const currentOrderId = orderId[0];
        const currentCancelQuantity = parseInt(cancelQuantity[0], 10);

        const order = await Order.findById(currentOrderId);

        if (!order) {
            return res.status(404).json({ message: `Order with ID ${currentOrderId} not found` });
        }

        const productIndex = order.product.findIndex(p => p._id.toString() === currentProductId.toString());
        if (productIndex === -1) {
            return res.status(404).json({ message: `Product with ID ${currentProductId} not found in order with ID ${currentOrderId}` });
        }

        const product = order.product[productIndex];

        if (currentCancelQuantity > product.quantity) {
            return res.status(400).json({ message: `Cancel quantity ${currentCancelQuantity} exceeds available product quantity ${product.quantity}` });
        }

        // Update the product quantity in the order or remove if all canceled
        if (currentCancelQuantity < product.quantity) {
            order.product[productIndex].quantity -= currentCancelQuantity;
        } else {
            order.product.splice(productIndex, 1);
        }

        // Push the canceled product details to the cancel array
        order.cancel.push({ ...product, quantity: currentCancelQuantity });

        // Adjust the order's total price
        const cancelAmount = product.price * currentCancelQuantity;
        order.totalPrice -= cancelAmount;

        // Mark the nested product array as modified
        order.markModified('product');

        // Update the order status to "Canceled" if all products are canceled
        if (order.product.length === 0) {
            order.status = "Canceled";
        }

        // Save the updated order
        await order.save();

        // Restore product stock by incrementing the canceled quantity
        await Product.findByIdAndUpdate(currentProductId, { $inc: { quantity: currentCancelQuantity } });

        // Add refunded amount to user's wallet if payment method is wallet or online
        if (order.payment === "wallet" || order.payment === "online") {
            findUser.wallet += cancelAmount;

            // Add history entry for the refund
            const newHistory = {
                amount: cancelAmount,
                amount: cancelAmount,
                status: "credit",
                date: Date.now()
            };
            findUser.history.push(newHistory);

            await findUser.save();
        }

        return res.json({ message: 'Product canceled successfully' });
    } catch (error) {
        console.error('Error canceling product:', error);
        return res.status(500).json({ message: 'Error canceling product' });
    }
};
;


// const getReturnProduct = async (req, res) => {
//     const userId = req.session.user;
//     const { productId, orderId } = req.query;

//     try {
//         // Fetch user, order, and product
//         const user = await User.findById(userId);
//         const order = await Order.findById(orderId);

//         // Assuming products are sub-documents of Order
//         const product = order.product.find(p => p._id.toString() === productId);

//         if (!user || !order || !product) {
//             return res.status(404).json({ message: 'User, order, or product not found' });
//         }

//         // Render the form with the fetched data
//         res.render('returnRequestForm', {
//             user,
//             product,
//             order
//         });
//     } catch (error) {
//         console.error(error);
//         res.status(500).send('Error fetching data');
//     }
// };


const getReturnOrder = async (req, res) => {
    try {
        const userId = req.session.user;
        const Userid = new mongodb.ObjectId(userId);

        const user = await User.findOne({ _id: Userid });
        console.log("returnOrder>>>>" + user);
        if (!user) { // Fix this condition to check for user existence
            return res.status(404).json({ message: 'User not found' });
        }

        const id = req.query.id;
      

        const order = await Order.findOne({ _id: id });

        const products = order ? order.product : null; // Ensure order is defined before accessing its products

        if (!order || !products) {
            console.log('Order or product not found');
            return res.status(404).json({ message: 'Order or product not found' });
        }

        res.render('orderReturnRequestForm', {
            user,
            products: order.product,
            order
        });

    } catch (error) {
        console.log(error.message);
        res.status(500).json({ message: 'Internal server error' });
    }
}


const returnProduct = async (req, res) => {
    const { userId, orderId, products, reason } = req.body;

    console.log(req.body);

    if (!userId || !orderId || !products || !reason || !products.length) {
        return res.status(400).json({ message: 'All fields are required' });
    }
  
    let order = await Order.findById(orderId)
    
   
    await order.save()
    try {
        const returnRequests = products.map(product => ({
            userId,
            orderId,
             
            productId: product.productId,
            quantity: product.quantity,
            reason
        }));

        await Return.insertMany(returnRequests);

        res.status(200).json({ message: 'Return request submitted successfully!' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error submitting return request' });
    }
};



module.exports = {
    getCheckoutPage,
    orderPlaced,
    changeOrderStatus,
    getOrderDetailsPage,
    getOrderListPageAdmin,
    cancelOrder,
    getReturnOrder,
    getCartCheckoutPage,
    getOrderDetailsPageAdmin,
    verify,
    getInvoice,
    cancelProduct,
    // getReturnProduct,
    returnProduct,

}