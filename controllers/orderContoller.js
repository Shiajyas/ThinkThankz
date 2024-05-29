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
        const { totalPrice, addressId, payment, productId, isSingle } = req.body;
        const userId = req.session.user;
        const couponDiscount = req.session.coupon || 0;
        req.session.payment = payment
        const findUser = await User.findById(userId);
        const address = await Address.findOne({ userId });
        const findAddress = address.address.find(item => item._id.toString() === addressId);

        let newOrder;

        if (isSingle === "true") {
            const findProduct = await Product.findById(productId);
            const productDetails = {
                _id: findProduct._id,
                price: findProduct.salePrice,
                name: findProduct.productName,
                image: findProduct.productImage[0],
                productOffer: findProduct.regularPrice - findProduct.salePrice,
                quantity: 1
            };

            newOrder = new Order({
                product: [productDetails],
                totalPrice,
                address: findAddress,
                payment,
                userId,
                couponDiscount,
                createdOn: Date.now(),
                status: "Pending",
            });

            findProduct.quantity -= 1;
            await findProduct.save();

        } else {
            const productIds = findUser.cart.map(item => item.productId);
            const findProducts = await Product.find({ _id: { $in: productIds } });

            const cartItemQuantities = findUser.cart.map((item) => ({
                productId: item.productId,
                quantity: item.quantity
            }));

            const orderedProducts = findProducts.map((item) => ({
                _id: item._id,
                price: item.salePrice,
                regularPrice: item.regularPrice,
                name: item.productName,
                productOffer: item.regularPrice - item.salePrice,
                image: item.productImage[0],
                quantity: cartItemQuantities.find(cartItem => cartItem.productId.toString() === item._id.toString()).quantity
            }));

            newOrder = new Order({
                product: orderedProducts,
                totalPrice,
                address: findAddress,
                payment,
                userId,
                couponDiscount,
                createdOn: Date.now(),
                status: "Pending",
            });

            for (let i = 0; i < orderedProducts.length; i++) {
                const product = await Product.findById(orderedProducts[i]._id);
                product.quantity -= orderedProducts[i].quantity;
                await product.save();
            }
        }

        const orderDone = await newOrder.save();

        if (payment === 'cod') {
            newOrder.status = "Confirmed";
            await newOrder.save();
            if (isSingle !== "true") {
                await User.updateOne({ _id: userId }, { $set: { cart: [] } });
            }
            res.json({ payment: true, method: "cod", order: orderDone, orderId: userId });
        } else if (payment === 'online') {
            const generatedOrder = await generateOrderRazorpay(orderDone._id, totalPrice);
            res.json({ payment: false, method: "online", razorpayOrder: generatedOrder, order: orderDone, orderId: orderDone._id });
        } else if (payment === 'wallet') {
            if (totalPrice <= findUser.wallet) {
                findUser.wallet -= totalPrice;
                findUser.history.push({ amount: totalPrice, status: "debit", date: Date.now() });
                await findUser.save();
                newOrder.status = "Confirmed";
                await newOrder.save();
                if (isSingle !== "true") {
                    await User.updateOne({ _id: userId }, { $set: { cart: [] } });
                }
                res.json({ payment: true, method: "wallet", order: orderDone, orderId: orderDone._id });
            } else {
                res.json({ payment: false, method: "wallet", success: false });
            }
        }
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
};



const generateOrderRazorpay = (orderId, total) => {
    return new Promise((resolve, reject) => {
        const options = {
            amount: total * 100, // amount in paise
            currency: "INR",
            receipt: String(orderId)
        };
        instance.orders.create(options, (err, order) => {
            if (err) {
                reject(err);
            } else {
                resolve(order);
            }
        });
    });
};


const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body.payment;
        const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
        hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
        const generatedSignature = hmac.digest('hex');

        if (generatedSignature === razorpay_signature) {
            const order = await Order.findById(razorpay_order_id);
            if (order) {
                order.status = "Confirmed";
                await order.save();

                // Clear the cart only after successful payment
                if (order.product.length > 1) { // This assumes cart orders have more than one product
                    await User.updateOne({ _id: order.userId }, { $set: { cart: [] } });
                }

                res.json({ status: true });
            } else {
                res.status(400).json({ status: false, message: 'Order not found' });
            }
        } else {
            res.json({ status: false });
        }
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

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

const logPaymentFailure = async (req, res) => {
    try {
        const { description, user_id, product_id } = req.body;

        // Ensure product_id is defined and is an array
        if (!product_id || !Array.isArray(product_id)) {
            return res.status(400).json({ error: "Invalid product IDs" });
        }

        // Remove products from user's cart
        const user = await User.findById(user_id);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        product_id.forEach(async (id) => {
            // Filter out the product with the given ID from the cart
            user.cart = user.cart.filter(item => item.productId.toString() !== id.toString());
        });

        await user.save();

        // Optionally, log the failure details for further analysis
        console.log('Payment failure description:', description);
        console.log('Product IDs removed from cart:', product_id);

        res.status(200).send({ status: 'logged' });
    } catch (error) {
        console.error('Error logging payment failure:', error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};



const savePendingOrder = async (req, res) => {
    const { order_id, user_id, product_id, total_price, address_id } = req.body;

    try {
        // Fetch user and address details
        const user = await User.findById(user_id);
        const couponDiscount = req.session.coupon || 0;
        const payment = req.session.payment
        if (!user) {
            return res.status(404).send({ status: 'User not found' });
        }

        const address = await Address.findOne({ userId: user_id });
        if (!address) {
            return res.status(404).send({ status: 'Address not found' });
        }

        const findAddress = address.address.find(item => item._id.toString() === address_id);
        if (!findAddress) {
            return res.status(404).send({ status: 'Address not found' });
        }

        // Fetch product details
        const products = await Product.find({ _id: { $in: product_id } });

        const cartItemQuantities = user.cart.map((item) => ({
            productId: item.productId,
            quantity: item.quantity
        }));
        // Format product details
        const productDetails = products.map(item => ({
            _id: item._id,
            price: item.salePrice,
            regularPrice: item.regularPrice,
            name: item.productName,
            productOffer: item.regularPrice - item.salePrice,
            image: item.productImage[0],
            quantity: cartItemQuantities.find(cartItem => cartItem.productId.toString() === item._id.toString()).quantity
       
        }));

        // Create a new pending order
        const pendingOrder = new Order({
            product: productDetails,
            totalPrice: total_price,
            address: findAddress,
            userId: user_id,
            couponDiscount,
            payment: payment,
            status: 'Pending'
        });

        // Save the pending order
        await pendingOrder.save();
        res.status(200).send({ status: 'Pending order saved' });
    } catch (error) {
        console.error('Error saving pending order:', error);
        res.status(500).send({ status: 'error', error: error.message });
    }
};


const retryPayment = async (req, res) => {
    const { orderId } = req.body;
    try {
        const order = await Order.findOne({ orderId: orderId });

        if (!order) {
            return res.status(404).send({ status: 'order not found' });
        }

        // Here you can integrate the Razorpay payment retry logic
        // Assuming you have a function retryPayment that takes an order and processes the payment
        retryPayment(order, (error, paymentResponse) => {
            if (error) {
                return res.status(500).send({ status: 'payment error', error: error.message });
            }

            if (paymentResponse.status === 'success') {
                order.status = 'Completed';
                order.save();
                res.status(200).send({ status: 'payment successful' });
            } else {
                res.status(400).send({ status: 'payment failed' });
            }
        });

    } catch (error) {
        console.error('Error retrying payment:', error);
        res.status(500).send({ status: 'error', error: error.message });
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
    verifyPayment,
    getInvoice,
    cancelProduct,
    // getReturnProduct,
    returnProduct,
    logPaymentFailure,
    savePendingOrder,
    retryPayment

}