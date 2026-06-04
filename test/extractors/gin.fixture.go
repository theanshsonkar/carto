// Spec 11 fixture — Gin HTTP routes with a route group.
package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	api := r.Group("/api")
	api.GET("/users", listUsers)
	api.POST("/users", createUser)
	api.PUT("/users/:id", updateUser)
	r.Run()
}

func listUsers(c *gin.Context)   {}
func createUser(c *gin.Context)  {}
func updateUser(c *gin.Context)  {}
