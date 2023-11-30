const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.y2vlbq8.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const userCollection = client.db("zzDB").collection("user");
    const postCollection = client.db("zzDB").collection("post");
    const commentCollection = client.db("zzDB").collection("comment");

    // middlewares

    // jwt related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "2h",
      });
      res.send({ token });
    });

    //   User related api
    app.post("/users", async (req, res) => {
      const user = req.body;
      // insert email if user does not exist
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exist", insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });
    app.get("/users", async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await userCollection.findOne(query);
      res.send(result);
    });
    // make admin
    app.patch('/users/admin/:id', async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: {
          role: 'admin'
        }
      }
      const result = await userCollection.updateOne(filter, updatedDoc);
      res.send(result);
    })

    // ---------------- post related api-----------------//

    // add post
    app.post("/post", async (req, res) => {
      const item = req.body;
      const result = await postCollection.insertOne(item);
      res.send(result);
    });
    // get post
    app.get("/post", async (req, res) => {
      const result = await postCollection.find().toArray();
      res.send(result);
    });
    // get specific post
    app.get("/post/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await postCollection.findOne(query);
      res.send(result);
    });
    // upvotes & downvote
    app.patch("/post/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await postCollection.updateOne(query, req.body);
      res.send(result);
    });
    // delete post
    app.delete("/post/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await postCollection.deleteOne(query);
      res.send(result);
    });


    // get user specific post
    // ...

    // Get posts for a specific user
    app.get("/user/:email/posts", async (req, res) => {
        const userEmail = req.params.email;
        const query = { authorEmail: userEmail };
        const userPosts = await postCollection.find(query).toArray();
        res.send(userPosts);
    });

    // ...

    // --------comments---------//
    // add comment
    app.post("/comment", async (req, res) => {
      const item = req.body;
      const result = await commentCollection.insertOne(item);
      res.send(result);
    });
    // get comment by post id
    // Add this endpoint to your Express app
    app.get("/post/:postId/comments", async (req, res) => {
      const postId = req.params.postId;
      const query = { postId: postId };
      const comments = await commentCollection.find(query).toArray();
      res.send(comments);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("is running");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
